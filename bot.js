const TelegramBot = require('node-telegram-bot-api');
const { createWorker } = require('tesseract.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔑 Переменные окружения (не вставляй сюда токены!)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = 'deepseek-coder'; // можно заменить на deepseek-chat

// Папка для хранения истории диалогов
const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR);
}

// Создаём бота
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// OCR: инициализация Tesseract
let worker;
async function initOCR() {
  worker = createWorker({
    logger: m => console.log(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`),
  });
  await worker.load();
  await worker.loadLanguage('eng+rus');
  await worker.initialize('eng+rus');
  console.log('✅ OCR-движок Tesseract готов');
}
initOCR();

// Загрузка истории диалога
function loadSession(chatId) {
  const file = path.join(SESSIONS_DIR, `${chatId}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  return [];
}

// Сохранение истории диалога
function saveSession(chatId, messages) {
  const file = path.join(SESSIONS_DIR, `${chatId}.json`);
  fs.writeFileSync(file, JSON.stringify(messages, null, 2));
}

// Отправка длинного сообщения (разбивка на части)
function sendLong(bot, chatId, text, options = {}) {
  const chunkSize = 4000;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    setTimeout(() => {
      bot.sendMessage(chatId, chunk, options).catch(console.error);
    }, (i / chunkSize) * 500);
  }
}

// Запрос к DeepSeek напрямую (без nodul.ru)
async function askDeepSeek(messages) {
  try {
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: MODEL,
        messages: messages,
        max_tokens: 2048,
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('Ошибка DeepSeek:', error.response?.data || error.message);
    return '❌ Ошибка при обращении к нейросети. Попробуйте позже.';
  }
}

// Обработка /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
🤖 *JS Assistant Bot* на базе DeepSeek-Coder

Я помогу с:
- Объяснением кода на JavaScript
- Анализом скриншотов (OCR)
- Поиском ошибок
- Генерацией примеров

📌 Просто напишите вопрос или пришлите фото кода.
  `, { parse_mode: 'Markdown' });
});

// Обработка сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;
  const document = msg.document;

  let session = loadSession(chatId);

  if (text && !text.startsWith('/')) {
    bot.sendMessage(chatId, '🧠 Обрабатываю ваш запрос...');
    session.push({ role: 'user', content: text });

    const reply = await askDeepSeek(session);
    session.push({ role: 'assistant', content: reply });
    saveSession(chatId, session);

    sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
  }

  if (photo) {
    bot.sendMessage(chatId, '🖼️ Распознаю текст с изображения...');
    const fileId = photo[photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    try {
      const result = await worker.recognize(fileUrl);
      const extracted = result.data.text.trim();

      if (extracted) {
        bot.sendMessage(chatId, `\`\`\`\n${extracted}\n\`\`\`\n\n🔍 Анализирую код...`, { parse_mode: 'Markdown' });

        const prompt = `Проанализируй этот код или ошибку и объясни:\n\n${extracted}`;
        session.push({ role: 'user', content: prompt });

        const reply = await askDeepSeek(session);
        session.push({ role: 'assistant', content: reply });
        saveSession(chatId, session);

        sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, '❌ Текст не распознан. Попробуйте другой скриншот.');
      }
    } catch (err) {
      bot.sendMessage(chatId, '❌ Ошибка при обработке изображения.');
      console.error(err);
    }
  }

  if (document) {
    const fileName = msg.document.file_name;
    if (fileName.endsWith('.js') || fileName.endsWith('.txt')) {
      bot.sendMessage(chatId, '📄 Читаю файл...');
      const file = await bot.getFile(msg.document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await axios.get(fileUrl);
      const content = response.data.toString().substring(0, 16000);

      const prompt = `Проанализируй JS-код:\n\`\`\`js\n${content}\n\`\`\``;
      session.push({ role: 'user', content: prompt });

      const reply = await askDeepSeek(session);
      session.push({ role: 'assistant', content: reply });
      saveSession(chatId, session);

      sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
    }
  }
});

console.log('✅ JS Assistant Bot запущен. Готов к работе!');
