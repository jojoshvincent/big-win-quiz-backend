import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";

import { db } from "./db.js";
import {
  authMiddleware,
  hashPassword,
  normalizeEmail,
  signAccessToken,
  validateEmail,
  validatePassword,
  verifyPassword
} from "./auth.js";

import { generateOTP } from "./otp.js";
import { sendOTPEmail } from "./mailer.js";
import { analyzeSentimentAgentic } from "./sentimentAgent.js";

const app = express();
const QUIZ_LENGTH = 10;
const MAX_QUIZ_ATTEMPTS = 10;
app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // allow non-browser tools (no Origin header)
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: "64kb" }));

function loadQuizQuestions() {
  const filePath = path.join(process.cwd(), "questions.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length < QUIZ_LENGTH) {
    throw new Error(`questions.json must contain at least ${QUIZ_LENGTH} questions`);
  }
  return parsed.slice(0, QUIZ_LENGTH);
}

function toOptionObject(option, optionIndex) {
  const fallbackId = String.fromCharCode(97 + optionIndex); // a, b, c, d...
  if (typeof option === "string") {
    return { id: fallbackId, label: fallbackId.toUpperCase(), text: option };
  }
  return {
    id: String(option?.id ?? fallbackId),
    label: String(option?.label ?? String(option?.id ?? fallbackId).toUpperCase()),
    text: String(option?.text ?? "")
  };
}

function toPublicQuestion(question, questionIndex) {
  const normalizedOptions = Array.isArray(question.options)
    ? question.options.map((option, idx) => toOptionObject(option, idx))
    : [];
  return {
    id: String(question.id ?? questionIndex + 1),
    type: "multiple_choice",
    text: String(question.question ?? question.text ?? ""),
    options: normalizedOptions
  };
}

function normalizeAnswer(value) {
  return String(value ?? "").trim().toLowerCase();
}

function parseAttemptId(value) {
  const raw = String(value ?? "");
  if (raw.startsWith("att_")) {
    return Number(raw.slice(4));
  }
  return Number(raw);
}

function resolveCorrectOptionId(question, questionIndex) {
  const publicQuestion = toPublicQuestion(question, questionIndex);
  const options = publicQuestion.options;

  if (question.correctOptionId) {
    return String(question.correctOptionId).toLowerCase();
  }

  const correctAnswer = normalizeAnswer(question.correctAnswer);
  if (!correctAnswer) return null;

  const byId = options.find((opt) => normalizeAnswer(opt.id) === correctAnswer);
  if (byId) return normalizeAnswer(byId.id);

  const byText = options.find((opt) => normalizeAnswer(opt.text) === correctAnswer);
  if (byText) return normalizeAnswer(byText.id);

  return null;
}

/* ---------------- HEALTH ---------------- */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ---------------- SENTIMENT (AGENTIC) ---------------- */

function sentimentAnalysisJson(analysis) {
  return {
    message: analysis.message,
    sentiment: analysis.sentiment,
    score: analysis.score,
    scoreOutOf: 100,
    grading: analysis.grading,
    reason: analysis.reason,
    evidencePhrases: analysis.evidencePhrases,
    context: {
      isOnTopic: analysis.isOnTopic,
      topic: analysis.topic,
      emotions: analysis.emotions
    },
    meta: {
      provider: analysis.meta.provider,
      model: analysis.meta.model,
      agents: analysis.agents,
      skippedReason: analysis.meta.skippedReason ?? null
    }
  };
}

function parseSubmissionText(req) {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return { error: "text is required" };
  return { text };
}

function validateWordCount(analysis) {
  if (analysis.wordCount !== 25) {
    return {
      error: "text must contain exactly 25 words",
      receivedWordCount: analysis.wordCount
    };
  }
  return null;
}

function saveCreativeSubmissionOrThrow(userId, text, analysis) {
  const existing = db.prepare(`
    SELECT creative_submission_completed
    FROM users WHERE id = ?
  `).get(userId);

  if (!existing) {
    const err = new Error("User not found");
    err.status = 401;
    throw err;
  }

  if (Number(existing.creative_submission_completed) === 1) {
    const err = new Error("Creative submission already completed");
    err.status = 409;
    throw err;
  }

  const g = analysis.grading;
  db.prepare(`
    UPDATE users SET
      creative_submission_score = ?,
      creative_score_relevance = ?,
      creative_score_creativity = ?,
      creative_score_clarity = ?,
      creative_score_metaphor = ?,
      creative_score_impact = ?,
      creative_submission_text = ?,
      creative_submission_sentiment = ?,
      creative_submission_is_on_topic = ?,
      creative_submission_completed = 1,
      creative_submission_submitted_at = datetime('now')
    WHERE id = ?
  `).run(
    analysis.score,
    g.relevanceToPrompt,
    g.creativityOriginality,
    g.clarityExpression,
    g.metaphoricalResonance,
    g.overallImpact,
    text,
    analysis.sentiment,
    analysis.isOnTopic ? 1 : 0,
    userId
  );

  const row = db.prepare(`
    SELECT creative_submission_submitted_at
    FROM users WHERE id = ?
  `).get(userId);

  return {
    completed: true,
    score: analysis.score,
    submittedAt: row?.creative_submission_submitted_at ?? null
  };
}

function getCreativeRankingForUser(userId) {
  const totalUsers = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE creative_submission_completed = 1
      AND creative_submission_score IS NOT NULL
  `).get()?.count ?? 0);

  const userRow = db.prepare(`
    SELECT creative_submission_completed, creative_submission_score
    FROM users
    WHERE id = ?
  `).get(userId);

  const completed = Number(userRow?.creative_submission_completed ?? 0) === 1;
  const score = userRow?.creative_submission_score;
  if (!completed || score === null || score === undefined || totalUsers === 0) {
    return {
      rank: null,
      totalUsers,
      topPercent: null,
      topPercentRounded: null,
      topLabel: null
    };
  }

  const higherScoreBands = Number(db.prepare(`
    SELECT COUNT(DISTINCT creative_submission_score) AS count
    FROM users
    WHERE creative_submission_completed = 1
      AND creative_submission_score IS NOT NULL
      AND creative_submission_score > ?
  `).get(score)?.count ?? 0);

  const rank = higherScoreBands + 1;
  const topPercent = Number(((rank / totalUsers) * 100).toFixed(2));
  const topPercentRounded = Math.max(1, Math.ceil(topPercent));

  return {
    rank,
    totalUsers,
    topPercent,
    topPercentRounded,
    topLabel: `Top ${topPercentRounded}% of ${totalUsers} users`
  };
}

app.post("/sentiment/analyze", async (req, res) => {
  try {
    const parsed = parseSubmissionText(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const analysis = await analyzeSentimentAgentic(parsed.text);
    const wordCountError = validateWordCount(analysis);
    if (wordCountError) return res.status(400).json(wordCountError);

    return res.json(sentimentAnalysisJson(analysis));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to analyze sentiment" });
  }
});

/* ---------------- CREATIVE SUBMISSION (AUTH, PERSISTED) ---------------- */

app.post("/creative-submission", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: "Invalid token" });

    const parsed = parseSubmissionText(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const analysis = await analyzeSentimentAgentic(parsed.text);
    const wordCountError = validateWordCount(analysis);
    if (wordCountError) return res.status(400).json(wordCountError);

    const creativeSubmission = saveCreativeSubmissionOrThrow(userId, parsed.text, analysis);
    const ranking = getCreativeRankingForUser(userId);

    return res.status(201).json({
      ...sentimentAnalysisJson(analysis),
      creativeSubmission: {
        ...creativeSubmission,
        ranking
      }
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to save creative submission" });
  }
});

/* ---------------- REGISTER (SEND OTP) ---------------- */

app.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });

    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const existing = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);

    if (existing)
      return res.status(409).json({ error: "Email already registered" });

    // generate OTP
    const otp = generateOTP();

    // expires in 5 minutes
    const expiresAt = new Date(
      Date.now() + 5 * 60 * 1000
    ).toISOString();

    db.prepare(`
      INSERT INTO email_otps (email, otp, expires_at)
      VALUES (?, ?, ?)
    `).run(email, otp, expiresAt);

    // send email
    await sendOTPEmail(email, otp);

    return res.json({
      message: "OTP sent to email"
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

/* ---------------- VERIFY EMAIL ---------------- */

app.post("/verify-email", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp ?? "");
    const password = String(req.body?.password ?? "");

    const record = db.prepare(`
      SELECT * FROM email_otps
      WHERE email = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(email);

    if (!record)
      return res.status(400).json({ error: "OTP not found" });

    if (record.otp !== otp)
      return res.status(400).json({ error: "Invalid OTP" });

    if (new Date(record.expires_at) < new Date())
      return res.status(400).json({ error: "OTP expired" });

    const passwordHash = await hashPassword(password);

    const info = db.prepare(`
      INSERT INTO users (email, password_hash, payment_status)
      VALUES (?, ?, ?)
    `).run(email, passwordHash, 1);

    // cleanup OTP
    db.prepare("DELETE FROM email_otps WHERE email = ?").run(email);

    const token = signAccessToken({
      sub: String(info.lastInsertRowid),
      email
    });

    return res.json({
      message: "Email verified successfully",
      token
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

/* ---------------- LOGIN ---------------- */

app.post("/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password ?? "");

  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr });

  if (!password)
    return res.status(400).json({ error: "Password is required" });

  const user = db
    .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
    .get(email);

  if (!user)
    return res.status(401).json({ error: "Invalid email or password" });

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok)
    return res.status(401).json({ error: "Invalid email or password" });

  const token = signAccessToken({
    sub: String(user.id),
    email: user.email
  });

  return res.json({ token });
});

/* ---------------- CURRENT USER ---------------- */

app.get("/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

/* ---------------- DASHBOARD ---------------- */

function mapLastAttemptStatus(dbStatus) {
  if (!dbStatus) return "none";
  if (dbStatus === "completed") return "passed";
  if (dbStatus === "failed") return "failed";
  if (dbStatus === "in_progress") return "in_progress";
  return "none";
}

function hasUserPassedQuiz(userId) {
  const passedAttempt = db.prepare(`
    SELECT 1
    FROM quiz_attempts
    WHERE user_id = ? AND status = 'completed'
    LIMIT 1
  `).get(userId);
  return Boolean(passedAttempt);
}

app.get("/dashboard", authMiddleware, (req, res) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: "Invalid token" });

    const userRow = db.prepare(`
      SELECT
        id,
        email,
        name,
        creative_submission_completed,
        creative_submission_score,
        creative_score_relevance,
        creative_score_creativity,
        creative_score_clarity,
        creative_score_metaphor,
        creative_score_impact,
        creative_submission_text,
        creative_submission_submitted_at,
        creative_submission_sentiment,
        creative_submission_is_on_topic
      FROM users WHERE id = ?
    `).get(userId);

    if (!userRow) return res.status(401).json({ error: "User not found" });

    const stats = db.prepare(`
      SELECT
        COUNT(*) AS attempt_count,
        MAX(score) AS best_score
      FROM quiz_attempts
      WHERE user_id = ?
    `).get(userId);

    const lastAttempt = db.prepare(`
      SELECT status
      FROM quiz_attempts
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(userId);
    const hasPassedQuiz = hasUserPassedQuiz(userId);

    const attemptCount = Number(stats?.attempt_count ?? 0);
    const hasAttemptedQuiz = attemptCount > 0;
    const bestRaw = stats?.best_score;
    const bestScorePercent =
      !hasAttemptedQuiz || bestRaw === null || bestRaw === undefined
        ? null
        : Math.min(100, Math.max(0, Number(bestRaw)));

    const lastAttemptStatus = mapLastAttemptStatus(lastAttempt?.status);

    const displayName = userRow.name != null && String(userRow.name).trim() !== ""
      ? String(userRow.name).trim()
      : null;

    const creativeCompleted = Number(userRow.creative_submission_completed) === 1;
    const creativeScoreRaw = userRow.creative_submission_score;
    const creativeScorePercent =
      !creativeCompleted || creativeScoreRaw === null || creativeScoreRaw === undefined
        ? null
        : Math.min(100, Math.max(0, Number(creativeScoreRaw)));

    return res.json({
      user: {
        id: userRow.id,
        email: userRow.email,
        name: displayName
      },
      quiz: {
        hasAttemptedQuiz,
        hasPassedQuiz,
        quizCompletedSuccessfully: hasPassedQuiz,
        attemptCount,
        bestScorePercent,
        lastAttemptStatus
      },
      creativeSubmission: {
        completed: creativeCompleted,
        scorePercent: creativeScorePercent,
        grading:
          creativeCompleted
            ? {
                relevanceToPrompt: userRow.creative_score_relevance,
                creativityOriginality: userRow.creative_score_creativity,
                clarityExpression: userRow.creative_score_clarity,
                metaphoricalResonance: userRow.creative_score_metaphor,
                overallImpact: userRow.creative_score_impact
              }
            : null,
        submittedAt: creativeCompleted ? userRow.creative_submission_submitted_at : null,
        sentiment: creativeCompleted ? userRow.creative_submission_sentiment : null,
        isOnTopic:
          creativeCompleted && userRow.creative_submission_is_on_topic != null
            ? Boolean(Number(userRow.creative_submission_is_on_topic))
            : null,
        text: creativeCompleted ? userRow.creative_submission_text : null
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load dashboard" });
  }
});

/* ---------------- SCOREBOARD ---------------- */

app.get("/scoreboard", authMiddleware, (req, res) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: "Invalid token" });

    const userRow = db.prepare(`
      SELECT
        creative_submission_completed,
        creative_submission_score,
        creative_score_relevance,
        creative_score_creativity,
        creative_score_clarity,
        creative_score_metaphor,
        creative_score_impact
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(userId);

    if (!userRow) return res.status(401).json({ error: "User not found" });

    const completed = Number(userRow.creative_submission_completed) === 1;
    const scoreRaw = userRow.creative_submission_score;
    const scorePercent =
      !completed || scoreRaw === null || scoreRaw === undefined
        ? null
        : Math.min(100, Math.max(0, Number(scoreRaw)));

    const ranking = getCreativeRankingForUser(userId);

    return res.json({
      creativeSubmission: {
        completed,
        scorePercent,
        grading:
          completed
            ? {
                relevanceToPrompt: userRow.creative_score_relevance,
                creativityOriginality: userRow.creative_score_creativity,
                clarityExpression: userRow.creative_score_clarity,
                metaphoricalResonance: userRow.creative_score_metaphor,
                overallImpact: userRow.creative_score_impact
              }
            : null,
        ranking
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load scoreboard" });
  }
});

/* ---------------- QUIZ ---------------- */

app.post("/quiz/start", authMiddleware, (req, res) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: "Invalid token" });
    const hasPassedQuiz = hasUserPassedQuiz(userId);

    const inProgress = db.prepare(`
      SELECT id, attempt_index, score, current_question_index, status
      FROM quiz_attempts
      WHERE user_id = ? AND status = 'in_progress'
      ORDER BY id DESC
      LIMIT 1
    `).get(userId);

    const questions = loadQuizQuestions();

    if (inProgress) {
      const current = questions[inProgress.current_question_index];
      return res.json({
        message: "Resuming in-progress attempt",
        attemptId: `att_${inProgress.id}`,
        attemptNumber: inProgress.attempt_index,
        hasPassedQuiz,
        quizCompletedSuccessfully: hasPassedQuiz,
        questionNumber: inProgress.current_question_index + 1,
        totalQuestions: QUIZ_LENGTH,
        timeLimitSec: 30,
        question: toPublicQuestion(current, inProgress.current_question_index)
      });
    }

    const totalAttempts = db.prepare(`
      SELECT COUNT(*) AS count
      FROM quiz_attempts
      WHERE user_id = ?
    `).get(userId).count;

    if (totalAttempts >= MAX_QUIZ_ATTEMPTS) {
      return res.status(403).json({ error: "Maximum quiz attempts reached" });
    }

    const attemptIndex = totalAttempts + 1;
    const info = db.prepare(`
      INSERT INTO quiz_attempts (user_id, attempt_index, status, score, current_question_index)
      VALUES (?, ?, 'in_progress', 0, 0)
    `).run(userId, attemptIndex);

    return res.status(201).json({
      message: "Quiz attempt started",
      attemptId: `att_${info.lastInsertRowid}`,
      attemptNumber: attemptIndex,
      hasPassedQuiz,
      quizCompletedSuccessfully: hasPassedQuiz,
      questionNumber: 1,
      totalQuestions: QUIZ_LENGTH,
      timeLimitSec: 30,
      question: toPublicQuestion(questions[0], 0)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to start quiz" });
  }
});

app.get("/quiz/current", authMiddleware, (req, res) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: "Invalid token" });
    const hasPassedQuiz = hasUserPassedQuiz(userId);

    const attempt = db.prepare(`
      SELECT id, attempt_index, score, current_question_index, status
      FROM quiz_attempts
      WHERE user_id = ? AND status = 'in_progress'
      ORDER BY id DESC
      LIMIT 1
    `).get(userId);

    if (!attempt) return res.status(404).json({ error: "No in-progress attempt" });

    const questions = loadQuizQuestions();
    const question = questions[attempt.current_question_index];
    if (!question) {
      return res.status(400).json({ error: "Quiz state is out of sync with questions.json" });
    }

    return res.json({
      attemptId: `att_${attempt.id}`,
      attemptNumber: attempt.attempt_index,
      hasPassedQuiz,
      quizCompletedSuccessfully: hasPassedQuiz,
      questionNumber: attempt.current_question_index + 1,
      totalQuestions: QUIZ_LENGTH,
      timeLimitSec: 30,
      question: toPublicQuestion(question, attempt.current_question_index)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch current question" });
  }
});

app.post("/quiz/answer", authMiddleware, (req, res) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: "Invalid token" });
    const hasPassedQuiz = hasUserPassedQuiz(userId);

    const attemptId = parseAttemptId(req.body?.attemptId);
    const questionId = String(req.body?.questionId ?? "");
    const selectedOptionId = String(req.body?.selectedOptionId ?? "");
    const timeTakenSec = Number(req.body?.timeTakenSec ?? 0);

    if (!attemptId || !questionId || !selectedOptionId) {
      return res.status(400).json({ error: "attemptId, questionId and selectedOptionId are required" });
    }

    const attempt = db.prepare(`
      SELECT id, attempt_index, score, current_question_index, status
      FROM quiz_attempts
      WHERE user_id = ? AND id = ? AND status = 'in_progress'
      LIMIT 1
    `).get(userId, attemptId);

    if (!attempt) return res.status(404).json({ error: "No in-progress attempt" });

    const questions = loadQuizQuestions();
    const index = attempt.current_question_index;
    const question = questions[index];

    if (!question) {
      return res.status(400).json({ error: "Quiz state is out of sync with questions.json" });
    }

    const expectedQuestionId = String(question.id ?? index + 1);
    if (questionId !== expectedQuestionId) {
      return res.status(409).json({ error: "Question mismatch for current attempt state" });
    }

    const correctOptionId = resolveCorrectOptionId(question, index);
    if (!correctOptionId) {
      return res.status(500).json({ error: "Question does not define a valid correct answer" });
    }

    const isCorrect = normalizeAnswer(selectedOptionId) === correctOptionId;

    db.prepare(`
      INSERT INTO attempt_answers (attempt_id, question_id, question_index, answer_given, is_correct)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      attempt.id,
      String(question.id ?? index + 1),
      index,
      JSON.stringify({ selectedOptionId, timeTakenSec }),
      isCorrect ? 1 : 0
    );

    if (!isCorrect) {
      db.prepare(`
        UPDATE quiz_attempts
        SET status = 'failed', ended_at = datetime('now')
        WHERE id = ?
      `).run(attempt.id);

      return res.json({
        result: "incorrect",
        attemptStatus: "failed",
        attemptNumber: attempt.attempt_index,
        hasPassedQuiz,
        quizCompletedSuccessfully: hasPassedQuiz,
        message: "Incorrect answer. Attempt ended."
      });
    }

    const nextScore = attempt.score + 10;
    const nextIndex = index + 1;

    if (nextIndex >= QUIZ_LENGTH) {
      db.prepare(`
        UPDATE quiz_attempts
        SET score = ?, current_question_index = ?, status = 'completed', ended_at = datetime('now')
        WHERE id = ?
      `).run(nextScore, nextIndex, attempt.id);

      return res.json({
        result: "correct",
        attemptStatus: "passed",
        attemptNumber: attempt.attempt_index,
        hasPassedQuiz: true,
        quizCompletedSuccessfully: true,
        message: "Quiz completed successfully"
      });
    }

    db.prepare(`
      UPDATE quiz_attempts
      SET score = ?, current_question_index = ?
      WHERE id = ?
    `).run(nextScore, nextIndex, attempt.id);

    return res.json({
      result: "correct",
      attemptStatus: "in_progress",
      attemptNumber: attempt.attempt_index,
      hasPassedQuiz,
      quizCompletedSuccessfully: hasPassedQuiz,
      nextQuestion: {
        attemptNumber: attempt.attempt_index,
        questionNumber: nextIndex + 1,
        totalQuestions: QUIZ_LENGTH,
        timeLimitSec: 30,
        question: toPublicQuestion(questions[nextIndex], nextIndex)
      }
    });
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE constraint failed: attempt_answers")) {
      return res.status(409).json({ error: "Current question already answered" });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to submit answer" });
  }
});

app.post("/quiz/timeout", authMiddleware, (req, res) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: "Invalid token" });

    const attemptId = parseAttemptId(req.body?.attemptId);
    const questionId = String(req.body?.questionId ?? "");
    if (!attemptId || !questionId) {
      return res.status(400).json({ error: "attemptId and questionId are required" });
    }

    const attempt = db.prepare(`
      SELECT id, current_question_index
      FROM quiz_attempts
      WHERE user_id = ? AND id = ? AND status = 'in_progress'
      LIMIT 1
    `).get(userId, attemptId);

    if (!attempt) return res.status(404).json({ error: "No in-progress attempt" });

    const questions = loadQuizQuestions();
    const current = questions[attempt.current_question_index];
    const expectedQuestionId = String(current?.id ?? attempt.current_question_index + 1);

    if (questionId !== expectedQuestionId) {
      return res.status(409).json({ error: "Question mismatch for current attempt state" });
    }

    db.prepare(`
      UPDATE quiz_attempts
      SET status = 'failed', ended_at = datetime('now')
      WHERE id = ?
    `).run(attempt.id);

    return res.json({
      attemptStatus: "failed",
      message: "Time expired. Attempt ended."
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to process timeout" });
  }
});

/* ---------------- SERVER ---------------- */

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Auth API listening on http://localhost:${port}`);
});