const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = 'openrouter/free';
const GEMINI_MODEL = 'gemini-1.5-flash';

async function fetchGroq(prompt) {
  try {
    if (!GROQ_API_KEY) {
      return 'Groq Engine failed: missing GROQ_API_KEY environment variable.';
    }
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 2048
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return `Groq Engine failed: HTTP ${response.status} - ${errorText}`;
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || 'Groq Engine returned an empty response.';
  } catch (error) {
    return `Groq Engine failed: ${error.message}`;
  }
}

async function fetchOpenRouter(prompt) {
  try {
    if (!OPENROUTER_API_KEY) {
      return 'OpenRouter Free Router failed: missing OPENROUTER_API_KEY environment variable.';
    }
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://bharat-ai.app',
        'X-Title': 'Bharat Ai Triple Engine'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 2048
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return `OpenRouter Free Router failed: HTTP ${response.status} - ${errorText}`;
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || 'OpenRouter Free Router returned an empty response.';
  } catch (error) {
    return `OpenRouter Free Router failed: ${error.message}`;
  }
}

async function fetchGemini(prompt) {
  try {
    if (!GEMINI_API_KEY) {
      return 'Google Gemini Flash failed: missing GEMINI_API_KEY environment variable.';
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048
        }
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return `Google Gemini Flash failed: HTTP ${response.status} - ${errorText}`;
    }
    const data = await response.json();
    const candidate = data.candidates?.[0];
    return candidate?.content?.parts?.map(part => part.text).join('').trim() || 'Google Gemini Flash returned an empty response.';
  } catch (error) {
    return `Google Gemini Flash failed: ${error.message}`;
  }
}

app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Prompt is required and must be a non-empty string.' });
  }

  try {
    const [groqResponse, openrouterResponse, geminiResponse] = await Promise.all([
      fetchGroq(prompt),
      fetchOpenRouter(prompt),
      fetchGemini(prompt)
    ]);

    res.json({
      groqResponse,
      openrouterResponse,
      geminiResponse
    });
  } catch (error) {
    res.status(500).json({ error: `Triple engine error: ${error.message}` });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engines: { groq: !!GROQ_API_KEY, openrouter: !!OPENROUTER_API_KEY, gemini: !!GEMINI_API_KEY } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bharat Ai Triple Engine server running on port ${PORT}`);
});

module.exports = app;
