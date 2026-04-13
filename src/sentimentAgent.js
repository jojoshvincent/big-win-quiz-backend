const HF_API_KEY = process.env.HUGGINGFACE_API_KEY || "REPLACE_WITH_YOUR_HUGGINGFACE_API_KEY";
const DEFAULT_HF_SENTIMENT_MODEL = "cardiffnlp/twitter-roberta-base-sentiment-latest";
const HF_SENTIMENT_MODEL = process.env.HF_SENTIMENT_MODEL || DEFAULT_HF_SENTIMENT_MODEL;

const POSITIVE_CUES = new Set([
  "happy", "excited", "joy", "joyful", "grateful", "thrilled", "amazing", "great", "wonderful", "blessed", "proud"
]);
const NEGATIVE_CUES = new Set([
  "sad", "angry", "upset", "worried", "anxious", "fear", "regret", "stressed", "bad", "terrible", "awful"
]);
const CAR_WIN_CUES = new Set([
  "win", "won", "winning", "car", "vehicle", "prize", "lottery", "reward", "dream", "keys"
]);

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
  const hasWin = hitSet.has("win") || hitSet.has("won") || hitSet.has("winning") || hitSet.has("prize") || hitSet.has("lottery") || hitSet.has("reward");
  const isOnTopic = hasCar && hasWin;
  const confidence = isOnTopic ? 0.92 : Math.min(0.75, hitSet.size * 0.15);
  return {
    agent: "intent-context-agent",
    isOnTopic,
    topic: "winning a car",
    confidence,
    topicHits: [...hitSet]
  };
}

async function sentimentModelAgent(text) {
  if (!HF_API_KEY || HF_API_KEY === "REPLACE_WITH_YOUR_HUGGINGFACE_API_KEY") {
    throw new Error("Hugging Face API key is missing. Set HUGGINGFACE_API_KEY.");
  }

  const payload = JSON.stringify({ inputs: text, options: { wait_for_model: true } });
  const headers = {
    Authorization: `Bearer ${HF_API_KEY}`,
    "Content-Type": "application/json"
  };

  const candidateModels = HF_SENTIMENT_MODEL === DEFAULT_HF_SENTIMENT_MODEL
    ? [HF_SENTIMENT_MODEL]
    : [HF_SENTIMENT_MODEL, DEFAULT_HF_SENTIMENT_MODEL];

  let response = null;
  let selectedModel = HF_SENTIMENT_MODEL;
  let lastErrorDetails = "";

  for (const model of candidateModels) {
    const candidateUrls = [
      `https://router.huggingface.co/hf-inference/models/${model}`,
      `https://router.huggingface.co/models/${model}`
    ];

    for (const url of candidateUrls) {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: payload
      });
      if (response.ok) {
        selectedModel = model;
        break;
      }
      const details = await response.text();
      lastErrorDetails = `${url} -> (${response.status}) ${details}`;
      // Retry only when route is not found. For auth/rate-limit/model errors, fail fast.
      if (response.status !== 404) {
        throw new Error(`Hugging Face sentiment call failed: ${lastErrorDetails}`);
      }
    }
    if (response?.ok) break;
  }

  if (!response || !response.ok) {
    throw new Error(`Hugging Face sentiment call failed after router attempts: ${lastErrorDetails}`);
  }

  const data = await response.json();
  const labels = Array.isArray(data?.[0]) ? data[0] : Array.isArray(data) ? data : [];
  if (!labels.length) {
    throw new Error("Unexpected sentiment response format from Hugging Face.");
  }

  const top = [...labels].sort((a, b) => Number(b.score) - Number(a.score))[0];
  const normalizedLabel = String(top?.label ?? "").toLowerCase();
  let sentiment = "neutral";
  if (normalizedLabel.includes("pos")) sentiment = "positive";
  else if (normalizedLabel.includes("neg")) sentiment = "negative";

  return {
    agent: "llm-sentiment-agent",
    sentiment,
    confidence: Number(top?.score ?? 0.5),
    model: selectedModel
  };
}

function emotionAgent(tokens) {
  const emotionHits = [];
  for (const token of tokens) {
    if (POSITIVE_CUES.has(token) || NEGATIVE_CUES.has(token)) emotionHits.push(token);
  }
  const unique = [...new Set(emotionHits)];
  return {
    agent: "emotion-agent",
    cues: unique
  };
}

function scoringAgent({ sentiment, confidence }, context) {
  let score = 50;
  if (sentiment === "positive") score = 50 + Math.round(confidence * 50);
  if (sentiment === "negative") score = 50 - Math.round(confidence * 50);
  if (!context.isOnTopic) score -= 10;
  score = Math.max(0, Math.min(100, score));
  return { agent: "score-agent", score };
}

function reasoningAgent({ sentiment }, context, emotions, text) {
  const evidencePhrases = [];
  const lower = text.toLowerCase();
  const evidenceSeeds = ["won", "winning", "car", "prize", "lottery", "dream", "happy", "excited", "grateful", "sad", "worried"];
  for (const seed of evidenceSeeds) {
    if (lower.includes(seed)) evidencePhrases.push(seed);
  }
  const uniqueEvidence = [...new Set(evidencePhrases)].slice(0, 5);

  let reason = "The sentiment is inferred from the emotional cues in the text.";
  if (context.isOnTopic) {
    if (sentiment === "positive") {
      reason = "The text directly references winning a car and uses positive emotional cues, indicating a favorable feeling about the event.";
    } else if (sentiment === "negative") {
      reason = "Although the text references winning a car, the emotional cues are negative or conflicted, indicating concern or dissatisfaction.";
    } else {
      reason = "The text references winning a car, but emotional intensity is balanced or unclear, resulting in a neutral interpretation.";
    }
  } else {
    reason = "The text does not clearly describe a person's feelings about winning a car, so confidence in topic-specific sentiment is reduced.";
  }

  return {
    agent: "reasoning-agent",
    reason,
    evidencePhrases: uniqueEvidence,
    emotions: emotions.cues
  };
}

function responseAgent(sentiment, score) {
  if (sentiment === "positive") {
    return { message: "The text expresses a positive feeling." };
  }
  if (sentiment === "negative") {
    return { message: "The text expresses a negative feeling." };
  }
  if (score >= 60) {
    return { message: "The text is mostly positive with mild emotional strength." };
  }
  if (score <= 40) {
    return { message: "The text is mostly negative with mild emotional strength." };
  }
  return { message: "The text expresses a neutral feeling." };
}

function criticAgent(payload) {
  const hasReason = typeof payload.reason === "string" && payload.reason.length > 0;
  const hasScore = Number.isFinite(payload.score) && payload.score >= 0 && payload.score <= 100;
  return {
    agent: "critic-agent",
    valid: hasReason && hasScore
  };
}

export async function analyzeSentimentAgentic(text) {
  const tokenizerOutput = tokenizationAgent(text);
  const contextOutput = contextAgent(tokenizerOutput.tokens);
  const sentimentOutput = await sentimentModelAgent(text);
  const emotionOutput = emotionAgent(tokenizerOutput.tokens);
  const scoreOutput = scoringAgent(sentimentOutput, contextOutput);
  const reasoningOutput = reasoningAgent(sentimentOutput, contextOutput, emotionOutput, text);
  const responseOutput = responseAgent(sentimentOutput.sentiment, scoreOutput.score);
  const criticOutput = criticAgent({
    reason: reasoningOutput.reason,
    score: scoreOutput.score
  });

  if (!criticOutput.valid) {
    throw new Error("Agentic sentiment output did not pass validation.");
  }

  return {
    wordCount: tokenizerOutput.wordCount,
    sentiment: sentimentOutput.sentiment,
    message: responseOutput.message,
    score: scoreOutput.score,
    reason: reasoningOutput.reason,
    evidencePhrases: reasoningOutput.evidencePhrases,
    isOnTopic: contextOutput.isOnTopic,
    topic: contextOutput.topic,
    emotions: reasoningOutput.emotions,
    agents: {
      tokenizer: tokenizerOutput.agent,
      context: contextOutput.agent,
      sentiment: sentimentOutput.agent,
      emotion: emotionOutput.agent,
      reasoner: reasoningOutput.agent,
      scorer: scoreOutput.agent,
      critic: criticOutput.agent
    },
    meta: {
      provider: "huggingface",
      model: sentimentOutput.model
    }
  };
}
