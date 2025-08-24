// Cargar variables de entorno
require('dotenv').config();

// Importar librerías de Node.js
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

// Importar Baileys y sus dependencias
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const P = require('pino'); // Usamos Pino para un logging más limpio
const { Boom } = require('@hapi/boom');

const app = express();

// Usar las variables de entorno de Render para el puerto y el host
const port = process.env.PORT || process.env.SERV_PORT || 3000;
const host = process.env.SERV_HOST || '0.0.0.0';

// --- CORS CONFIG ---
app.use(cors({
    origin: 'https://barbiniwebdesign.com.ar', // 🔑 tu dominio autorizado
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Configurar Express
app.use(express.static('public'));
app.use(express.json());

// --- MÓDULOS DE DATOS Y ESTADO ---
let usuarios = [];
const RUTA_USUARIOS = 'usuarios.json';
const CACHE_DURATION_MS = 3600000; // 1 hora
const estadosClientes = {};
const webContentCache = {};

// --- Cargar usuarios al iniciar ---
async function cargarUsuarios() {
    try {
        const data = await fs.readFile(RUTA_USUARIOS, 'utf8');
        usuarios = JSON.parse(data);
        console.log(`✅ Usuarios cargados: ${usuarios.length} en total.`);
    } catch (err) {
        console.log(`⚠️ Archivo ${RUTA_USUARIOS} no encontrado o vacío. Se creará al añadir usuarios.`);
        usuarios = [];
    }
}
cargarUsuarios();

// --- IA Gemini ---
async function generarRespuestaIA(mensaje, contexto) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
    let contenidoWeb = '';

    const urlMatch = contexto.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
        const paginaUrl = urlMatch[0];
        const cacheEntry = webContentCache[paginaUrl];
        const now = Date.now();

        if (cacheEntry && (now - cacheEntry.timestamp < CACHE_DURATION_MS)) {
            console.log(`Web scraping: usando caché para ${paginaUrl}`);
            contenidoWeb = cacheEntry.content;
        } else {
            try {
                console.log(`Web scraping: obteniendo contenido de ${paginaUrl}`);
                const response = await fetch(paginaUrl);
                if (response.ok) {
                    const html = await response.text();
                    const textoPlano = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 1500);
                    contenidoWeb = `\n\nContenido de la web de la tienda (${paginaUrl}):\n${textoPlano}\n\n`;
                    webContentCache[paginaUrl] = { content: contenidoWeb, timestamp: now };
                } else {
                    console.error(`❌ Error al hacer fetch de la URL: ${response.status}`);
                }
            } catch (err) {
                console.error("❌ Error al obtener la página web:", err);
            }
        }
    }

    const promptCompleto = `Contexto: ${contexto}${contenidoWeb}\nMensaje: ${mensaje}`;
    const payload = {
        contents: [{ parts: [{ text: promptCompleto }] }]
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        const textoGenerado = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return textoGenerado || "No pude generar una respuesta. Por favor, inténtalo de nuevo.";
    } catch (err) {
        console.error("❌ Error llamando a la API de Gemini:", err);
        return "Hubo un error al procesar el mensaje. Por favor, inténtalo de nuevo más tarde.";
    }
}

// --- Crear cliente WhatsApp sin guardar sesión ---
async function crearCliente(usuario) {
    if (estadosClientes[usuario]?.conectado) {
        console.log(`Cliente para ${usuario} ya está conectado.`);
        return;
    }

    const { version } = await fetchLatestBaileysVersion();
    console.log(`Usando la versión de Baileys: ${version}`);

    // ⚠️ Sesión sin persistencia → siempre pedirá QR al reiniciar
    const socket = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        auth: undefined,
        browser: ['Bot de WhatsApp', 'Chrome', '1.0']
    });

    estadosClientes[usuario] = {
        socket: socket,
        qrCodeData: null,
        conectado: false,
        lastAttempt: 0
    };

    // --- Eventos de conexión ---
    socket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`QR generado para ${usuario}`);
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) estadosClientes[usuario].qrCodeData = url;
            });
        }

        if (connection === 'close') {
            console.log(`❌ Conexión cerrada para ${usuario}.`);
            estadosClientes[usuario].conectado = false;
            delete estadosClientes[usuario];
        } else if (connection === 'open') {
            console.log(`✅ Cliente ${usuario} conectado.`);
            estadosClientes[usuario].qrCodeData = null;
            estadosClientes[usuario].conectado = true;
        }
    });

    // --- Eventos de mensajes ---
    socket.ev.on('messages.upsert', async ({ messages }) => {
        for (const message of messages) {
            if (message.key.fromMe) continue;

            const sender = message.key.remoteJid;
            const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text;

            if (messageText) {
                console.log(`Mensaje recibido de ${sender}: ${messageText}`);
                const contexto = usuarios.find(u => u.usuario === usuario)?.contexto || '';
                try {
                    const respuesta = await generarRespuestaIA(messageText, contexto);
                    await socket.sendMessage(sender, { text: respuesta });
                } catch (err) {
                    console.error(`❌ Error al procesar el mensaje de ${sender}:`, err);
                    await socket.sendMessage(sender, { text: 'Hubo un error al procesar tu mensaje.' });
                }
            }
        }
    });
}

// --- Rutas API ---
app.get('/generate-qr', (req, res) => {
    const { text1: usuario, text2: contraseña } = req.query;
    const usuarioObj = usuarios.find(u => u.usuario === usuario && u.contraseña === contraseña);

    if (!usuarioObj) {
        return res.status(403).send('Usuario o contraseña incorrectos.');
    }

    const estado = estadosClientes[usuario] || {};

    if (!estado.socket) {
        crearCliente(usuario);
        return res.status(503).send('Iniciando conexión, espere...');
    }

    if (estado.conectado) {
        return res.send('CONECTADO');
    }
    if (estado.qrCodeData) {
        return res.send(estado.qrCodeData);
    }

    res.status(503).send('QR aún no disponible. Por favor, espere...');
});

app.post('/crear-usuario', async (req, res) => {
    const { usuario, contraseña, contexto } = req.body;
    console.log(`Intento de crear usuario: ${usuario}`);

    if (!usuario || !contraseña) {
        return res.status(400).json({ error: 'Faltan campos (usuario y contraseña).' });
    }
    if (usuarios.find(u => u.usuario === usuario)) {
        return res.status(400).json({ error: 'El usuario ya existe.' });
    }

    const nuevoUsuario = { usuario, contraseña, contexto: contexto || '' };
    usuarios.push(nuevoUsuario);

    try {
        await fs.writeFile(RUTA_USUARIOS, JSON.stringify(usuarios, null, 2));
        console.log(`✅ Usuario creado: ${usuario}`);
        res.json({ success: true, message: 'Usuario creado correctamente.' });
    } catch (err) {
        console.error('❌ Error al escribir el archivo de usuarios:', err);
        res.status(500).json({ error: 'Error interno al guardar el usuario.' });
    }
});

app.get('/status', (req, res) => {
    const { text1: usuario, text2: contraseña } = req.query;
    const usuarioObj = usuarios.find(u => u.usuario === usuario && u.contraseña === contraseña);

    if (!usuarioObj) {
        return res.status(403).json({ error: 'Credenciales incorrectas.' });
    }

    const estado = estadosClientes[usuario] || {};
    res.json({ conectado: estado.conectado || false });
});

// --- Iniciar servidor ---
app.listen(port, host, () => {
    console.log(`Servidor escuchando en http://${host}:${port}`);
});


// --- FUNCION INDEPENDIENTE IA ---
async function responderIA(texto, contexto = "") {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

    // El contexto se concatena con la pregunta
    const prompt = contexto 
        ? `Contexto: ${contexto}\n\nPregunta: ${texto}` 
        : texto;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }]
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        const textoGenerado = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        return textoGenerado || "La IA no pudo generar una respuesta.";
    } catch (err) {
        console.error("❌ Error llamando a la API de Gemini:", err);
        return "Error procesando la consulta.";
    }
}

app.post('/preguntar-ia', async (req, res) => {
    const { pregunta, contexto } = req.body;

    if (!pregunta) {
        return res.status(400).json({ error: 'Falta el campo "pregunta".' });
    }

    try {
        const respuesta = await responderIA(pregunta, contexto);
        res.json({ respuesta });
    } catch (err) {
        console.error("❌ Error en /preguntar-ia:", err);
        res.status(500).json({ error: 'Error interno al procesar la pregunta.' });
    }
});
