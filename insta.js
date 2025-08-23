import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();
puppeteer.use(StealthPlugin());

const USERNAME = process.env.INSTAGRAM_USERNAME;
const PASSWORD = process.env.INSTAGRAM_PASSWORD;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const COOKIES_PATH = './cookies.json';
const processedMentions = new Set();

async function humanDelay(min = 1000, max = 3000) {
  return new Promise(r => setTimeout(r, Math.random() * (max - min) + min));
}

async function loadCookies(page) {
  try {
    const cookies = JSON.parse(await fs.readFile(COOKIES_PATH, 'utf8'));
    await page.setCookie(...cookies);
    console.log('🍪 Cookies cargadas.');
    return true;
  } catch {
    console.log('No se encontraron cookies previas.');
    return false;
  }
}

async function saveCookies(page) {
  const cookies = await page.cookies();
  await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('✅ Cookies guardadas.');
}

async function generateComment(postContent, mentionText) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `Publicación: "${postContent}". Mención: "${mentionText}". Responde breve y amistoso.` }] }] })
    });
    const result = await response.json();
    return result?.candidates?.[0]?.content?.parts?.[0]?.text || '¡Gracias por la mención!';
  } catch (e) {
    console.error('Error Gemini:', e);
    return '¡Gracias por la mención!';
  }
}

async function startBot() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1024 });

  const hasCookies = await loadCookies(page);
  await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });

  if (!hasCookies) {
    await page.type('input[name="username"]', USERNAME, { delay: 100 });
    await page.type('input[name="password"]', PASSWORD, { delay: 100 });
    await humanDelay();
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await saveCookies(page);
  }

  console.log('✅ Sesión iniciada.');

  setInterval(async () => {
    try {
      await page.goto('https://www.instagram.com/accounts/activity/', { waitUntil: 'networkidle2' });
      await humanDelay(3000, 5000);

      const notifications = await page.$$eval('a[href*="/p/"]', links => links.map(a => a.href));
      for (const link of notifications) {
        if (!processedMentions.has(link)) {
          processedMentions.add(link);
          const newPage = await browser.newPage();
          await newPage.goto(link, { waitUntil: 'networkidle2' });

          const postText = await newPage.$eval('article', el => el.innerText).catch(() => '');
          const comment = await generateComment(postText, 'Gracias por etiquetarme');
          
          const inputSelector = 'textarea[aria-label="Agregar un comentario..."]';
          await newPage.type(inputSelector, comment, { delay: 50 });
          await newPage.click('button[type="submit"]');
          await newPage.close();
        }
      }
    } catch (err) {
      console.error('Error en revisión:', err);
    }
  }, 20000);

}

startBot();
