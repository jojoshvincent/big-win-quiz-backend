const HF_API_KEY = process.env.HUGGINGFACE_API_KEY || "REPLACE_WITH_YOUR_HUGGINGFACE_API_KEY";
/** Prefer a chat/instruct model; defaults to Llama 3 Instruct. */
const HF_GRADING_MODEL =
  process.env.HF_GRADING_MODEL ||
  process.env.HF_SENTIMENT_MODEL ||
  "meta-llama/Meta-Llama-3-8B-Instruct";

const CHAT_COMPLETIONS_URL = "https://router.huggingface.co/v1/chat/completions";

/** Score when text fails topic check; no LLM grading is run. */
const OFF_TOPIC_MIN_SCORE = 0;

const CAR_WIN_CUES = new Set([
  "win", "won", "winning", "car", "vehicle", "prize", "lottery", "reward", "dream", "keys"
]);

const GRADING_KEYS = [
  "relevanceToPrompt",
  "creativityOriginality",
  "clarityExpression",
  "metaphoricalResonance",
  "overallImpact"
];

function normalizeTokens(text) {
  return String(text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function tokenizationAgent(text) {
  const tokens = normalizeTokens(text);
  return { agent: "tokenization-agent", tokens, wordCount: tokens.length };
}

function contextAgent(tokens) {
  const hitTokens = tokens.filter((token) => CAR_WIN_CUES.has(token));
  const hitSet = new Set(hitTokens);
  const hasCar = hitSet.has("car") || hitSet.has("vehicle") || hitSet.has("keys");
  const hasWin =
    hitSet.has("win") ||
    hitSet.has("won") ||
    hitSet.has("winning") ||
    hitSet.has("prize") ||
    hitSet.has("lottery") ||
    hitSet.has("reward");
  const isOnTopic = hasCar && hasWin;
  return {
    agent: "intent-context-agent",
    isOnTopic,
    topic: "winning a car",
    topicHits: [...hitSet]
  };
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function averageScores(grading) {
  const vals = GRADING_KEYS.map((k) => clampScore(grading[k]));
  const sum = vals.reduce((a, b) => a + b, 0);
  return Math.round(sum / vals.length);
}

function emptyGradingZeros() {
  const g = {};
  for (const k of GRADING_KEYS) g[k] = 0;
  return g;
}

function extractJsonObject(raw) {
  const text = String(raw ?? "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function hfChatGrade(text, modelId) {
  if (!HF_API_KEY || HF_API_KEY === "REPLACE_WITH_YOUR_HUGGINGFACE_API_KEY") {
    throw new Error("Hugging Face API key is missing. Set HUGGINGFACE_API_KEY.");
  }

  const userContent = `You are grading a short creative writing submission.

Prompt focus: the writer's feelings about winning a car.
The submission is exactly 25 words (do not penalize length).

Score each criterion as an integer from 0 to 100:
1. Relevance to the Prompt
2. Creativity & Originality
3. Clarity & Expression
4. Metaphorical Resonance
5. Overall Impact

Return ONLY valid JSON with exactly these keys and integer values (no markdown, no extra text):
{"relevanceToPrompt":N,"creativityOriginality":N,"clarityExpression":N,"metaphoricalResonance":N,"overallImpact":N}

Submission text:
${text}`;

  const response = await fetch(CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: "system",
          content: "You output only valid JSON objects for rubric scores. No prose outside JSON."
        },
        { role: "user", content: userContent }
      ],
      temperature: 0.25,
      max_tokens: 256
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Hugging Face chat grading failed (${response.status}): ${details}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Unexpected chat completion response format from Hugging Face.");
  }

  const parsed = extractJsonObject(content);
  const grading = {};
  for (const key of GRADING_KEYS) {
    if (!(key in parsed)) {
      throw new Error(`Missing rubric key in model JSON: ${key}`);
    }
    grading[key] = clampScore(parsed[key]);
  }
  return grading;
}

async function llmGradingAgent(text) {
  const candidates = [...new Set([HF_GRADING_MODEL, process.env.HF_SENTIMENT_MODEL, "meta-llama/Meta-Llama-3-8B-Instruct"].filter(Boolean))];
  let lastErr = null;
  for (const modelId of candidates) {
    try {
      const grading = await hfChatGrade(text, modelId);
      return {
        agent: "llm-rubric-agent",
        grading,
        model: modelId
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("LLM grading failed");
}

export async function analyzeSentimentAgentic(text) {
  const tokenizerOutput = tokenizationAgent(text);
  const contextOutput = contextAgent(tokenizerOutput.tokens);

  if (!contextOutput.isOnTopic) {
    const zeros = emptyGradingZeros();
    return {
      wordCount: tokenizerOutput.wordCount,
      sentiment: "out_of_topic",
      message: "The text is not about winning a car, so grading was not performed.",
      score: OFF_TOPIC_MIN_SCORE,
      reason:
        "The text does not clearly relate to feelings about winning a car (missing expected topic cues). Rubric scoring was skipped and the minimum aggregate was assigned.",
      evidencePhrases: [],
      isOnTopic: false,
      topic: contextOutput.topic,
      emotions: [],
      grading: zeros,
      agents: {
        tokenizer: tokenizerOutput.agent,
        context: contextOutput.agent,
        topicGate: "topic-gate-agent",
        grader: "skipped"
      },
      meta: {
        provider: "huggingface",
        model: null,
        skippedReason: "off_topic"
      }
    };
  }

  const gradingOutput = await llmGradingAgent(text);
  const aggregateScore = averageScores(gradingOutput.grading);

  return {
    wordCount: tokenizerOutput.wordCount,
    sentiment: "graded",
    message: "Submission graded using the rubric model.",
    score: aggregateScore,
    reason: "Scores are produced by the LLM rubric for relevance, creativity, clarity, metaphor, and impact.",
    evidencePhrases: [],
    isOnTopic: true,
    topic: contextOutput.topic,
    emotions: [],
    grading: gradingOutput.grading,
    agents: {
      tokenizer: tokenizerOutput.agent,
      context: contextOutput.agent,
      grader: gradingOutput.agent
    },
    meta: {
      provider: "huggingface",
      model: gradingOutput.model
    }
  };
}
