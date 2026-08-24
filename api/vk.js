import { waitUntil } from "@vercel/functions";

const SYSTEM_PROMPT = `
Ты — доброжелательный ИИ-помощник школы английского языка «Играй и учись».
Ты общаешься с родителями детей 7–10 лет и помогаешь выбрать подходящую группу.

Проверенная информация:
- занятия проходят очно в комфортной оборудованной аудитории;
- урок длится 40 минут;
- занятия проходят в мини-группах;
- 1 класс: «Уверенный старт» — прочная база до начала английского в школе;
- 2 класс: «Школьный английский без пробелов» — разбор сложных тем и возвращение уверенности;
- 4 класс: «К ВПР без страха» — систематизация знаний и спокойная подготовка к ВПР;
- на занятиях дети играют, создают проекты, говорят, слушают истории, диалоги и поют песни;
- с собой нужна папка А4, пенал, цветные карандаши или фломастеры, простой карандаш, ластик, ручка, клей, ножницы и тонкая тетрадь в обычную клетку;
- преподаватель работает с детьми 7+ лет более 15 лет.

Правила ответа:
1. Отвечай по-русски, тепло, конкретно и не длиннее 700 знаков.
2. Не придумывай адрес, стоимость, расписание, свободные места и гарантии результата.
3. Если этих данных нет, скажи, что их уточнит преподаватель.
4. Если родитель хочет записаться, спроси по очереди: имя родителя, имя и класс ребёнка, опыт изучения английского и удобный способ связи.
5. Не проси медицинские, паспортные, платёжные или другие лишние персональные данные.
6. Если вопрос не относится к занятиям, вежливо верни разговор к английскому и записи в группу.
7. В конце ответа предлагай один понятный следующий шаг.
8. Показывай только готовый ответ родителю. Никогда не выводи рассуждения, служебные заметки, план ответа, слова «Take», «Next Step», «Reasoning» или инструкции для самого себя.
`;

const keyboard = JSON.stringify({
  one_time: false,
  inline: false,
  buttons: [
    [
      { action: { type: "text", label: "Подобрать группу", payload: "{\"action\":\"choose_group\"}" }, color: "primary" },
      { action: { type: "text", label: "Записаться", payload: "{\"action\":\"enroll\"}" }, color: "positive" }
    ],
    [
      { action: { type: "text", label: "1 класс", payload: "{\"route\":1}" }, color: "secondary" },
      { action: { type: "text", label: "2 класс", payload: "{\"route\":2}" }, color: "secondary" },
      { action: { type: "text", label: "4 класс / ВПР", payload: "{\"route\":4}" }, color: "secondary" }
    ],
    [
      { action: { type: "open_link", label: "Открыть сайт", link: process.env.SITE_URL || "https://igrai-i-uchis.mamasha1804.chatgpt.site", payload: "{}" } }
    ]
  ]
});

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function protectContactDetails(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[электронная почта скрыта]")
    .replace(/(?:\+7|8)[\s()\-]*\d(?:[\s()\-]*\d){9}/g, "[телефон скрыт]");
}

async function askGemini(text) {
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const apiKey = requiredEnv("GEMINI_API_KEY");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [{
        role: "user",
        parts: [{ text: protectContactDetails(text) }]
      }],
      generationConfig: {
        maxOutputTokens: 500,
        thinkingConfig: {
          thinkingLevel: "minimal"
        }
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini API ${response.status}: ${detail.slice(0, 500)}`);
  }

  const data = await response.json();
  const answer = data.candidates?.[0]?.content?.parts
    ?.filter((part) => part.text && part.thought !== true)
    .map((part) => part.text)
    .join("");

  const cleanedAnswer = answer
    ?.replace(/^\s*(?:Take|Next Step(?:\/Question)?|Reasoning)\s*[:*].*$/gim, "")
    .trim();

  if (!cleanedAnswer) throw new Error("Gemini returned an empty final answer");
  return cleanedAnswer
    .slice(0, 3000);
}

async function sendVkMessage(peerId, message) {
  const params = new URLSearchParams({
    access_token: requiredEnv("VK_TOKEN"),
    v: process.env.VK_API_VERSION || "5.199",
    peer_id: String(peerId),
    random_id: String(Math.floor(Math.random() * 2_147_483_647)),
    message,
    keyboard
  });

  const response = await fetch("https://api.vk.com/method/messages.send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(`VK API error: ${JSON.stringify(data.error || data).slice(0, 500)}`);
  }
}

async function processMessage(message) {
  const peerId = message.peer_id;
  const text = String(message.text || "").trim();
  if (!peerId) return;

  if (!text) {
    await sendVkMessage(peerId, "Пока я умею отвечать на текстовые сообщения. Напишите, пожалуйста, ваш вопрос словами 🙂");
    return;
  }

  try {
    const answer = await askGemini(text);
    await sendVkMessage(peerId, answer);
  } catch (error) {
    console.error("Message processing failed", error);
    await sendVkMessage(peerId, "Сейчас ИИ-помощник временно не смог ответить. Напишите, пожалуйста, ещё раз немного позже — или оставьте имя и класс ребёнка, и преподаватель свяжется с вами.");
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "Играй и учись — VK AI bot",
      configured: Boolean(process.env.VK_TOKEN && process.env.GEMINI_API_KEY)
    });
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const event = req.body || {};

  if (event.type === "confirmation") {
    return res.status(200).send(requiredEnv("VK_CONFIRMATION_CODE"));
  }

  if (process.env.VK_SECRET && event.secret !== process.env.VK_SECRET) {
    return res.status(403).send("Forbidden");
  }

  if (process.env.VK_GROUP_ID && String(event.group_id) !== String(process.env.VK_GROUP_ID)) {
    return res.status(403).send("Wrong group");
  }

  if (event.type === "message_new" && event.object?.message) {
    waitUntil(processMessage(event.object.message));
  }

  return res.status(200).send("ok");
}
