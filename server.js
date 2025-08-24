// Cargar variables de entorno
require('dotenv').config();

// Librerías
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch');

// Baileys
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const P = require('pino');
const { Boom } = require('@hapi/boom');

const app = express();

// --- CORS CONFIG ---
const allowedOrigins = ["https://barbiniwebdesign.com.ar", "http://localhost:3000"];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("No permitido por CORS"));
        }
    },
    methods: ['GET','POST'],
    allowedHeaders: ['Content-Type','Authorization']
}));

// Express
app.use(express.static('public'));
app.use(express.json());

// --- Datos y estado ---
let usuarios = [];
const RUTA_USUARIOS = 'usuarios.json';
const CACHE_DURATION_MS = 3600000;
const estadosClientes = {};
const webContentCache = {};

// --- Cargar usuarios ---
async function cargarUsuarios() {
    try {
        const data = await fs.readFile(RUTA_USUARIOS, 'utf8');
        usuarios = JSON.parse(data);
        console.log(`✅ Usuarios cargados: ${usuarios.length}`);
    } catch {
        usuarios = [];
        console.log(`⚠️ No hay archivo de usuarios, se creará al añadir uno.`);
    }
}
cargarUsuarios();

// --- FUNCION INDEPENDIENTE IA ---
async function responderIA(texto, contexto = "") {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
    const prompt = contexto ? `Contexto: ${contexto}\n\nPregunta: ${texto}` : texto;
    const payload = { contents: [{ parts: [{ text: prompt }] }] };

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
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || "La IA no pudo generar una respuesta.";
    } catch (err) {
        console.error("❌ Error llamando a Gemini:", err);
        return "Error procesando la consulta.";
    }
}

// --- Crear cliente WhatsApp sin guardar sesión ---
async function crearCliente(usuario) {
    if (estadosClientes[usuario]?.conectado) return;

    const { version } = await fetchLatestBaileysVersion();
    console.log(`Usando versión de Baileys: ${version}`);

    const socket = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        auth: undefined, // ⚠️ no guardar sesión
        browser: ['Bot de WhatsApp', 'Chrome', '1.0']
    });

    estadosClientes[usuario] = { socket, qrCodeData: null, conectado: false, lastAttempt: 0 };

    // Eventos de conexión
    socket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`QR generado para ${usuario}`);
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) estadosClientes[usuario].qrCodeData = url;
            });
        }

        if (connection === 'close') {
            console.log(`❌ Conexión cerrada para ${usuario}`);
            estadosClientes[usuario].conectado = false;
            delete estadosClientes[usuario];
        } else if (connection === 'open') {
            console.log(`✅ Cliente ${usuario} conectado`);
            estadosClientes[usuario].qrCodeData = null;
            estadosClientes[usuario].conectado = true;
        }
    });

    // Eventos de mensajes
    socket.ev.on('messages.upsert', async ({ messages }) => {
        for (const message of messages) {
            if (message.key.fromMe) continue;

            const sender = message.key.remoteJid;
            const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text;

            if (messageText) {
                console.log(`Mensaje de ${sender}: ${messageText}`);
                const contexto = usuarios.find(u => u.usuario === usuario)?.contexto || '';
                try {
                    const respuesta = await responderIA(messageText, contexto);
                    await socket.sendMessage(sender, { text: respuesta });
                } catch (err) {
                    console.error(`❌ Error al procesar mensaje de ${sender}:`, err);
                    await socket.sendMessage(sender, { text: 'Hubo un error procesando tu mensaje.' });
                }
            }
        }
    });
}

// --- RUTAS ---
// Generar QR WhatsApp
app.get('/generate-qr', (req, res) => {
    const { text1: usuario, text2: contraseña } = req.query;
    const usuarioObj = usuarios.find(u => u.usuario === usuario && u.contraseña === contraseña);
    if (!usuarioObj) return res.status(403).send('Usuario o contraseña incorrectos.');

    const estado = estadosClientes[usuario] || {};
    if (!estado.socket) {
        crearCliente(usuario);
        return res.status(503).send('Iniciando conexión, espere...');
    }
    if (estado.conectado) return res.send('CONECTADO');
    if (estado.qrCodeData) return res.send(estado.qrCodeData);

    res.status(503).send('QR aún no disponible. Por favor, espere...');
});

// Crear usuario
app.post('/crear-usuario', async (req, res) => {
    const { usuario, contraseña, contexto } = req.body;
    if (!usuario || !contraseña) return res.status(400).json({ error: 'Faltan campos.' });
    if (usuarios.find(u => u.usuario === usuario)) return res.status(400).json({ error: 'Usuario ya existe.' });

    const nuevoUsuario = { usuario, contraseña, contexto: contexto || '' };
    usuarios.push(nuevoUsuario);

    try {
        await fs.writeFile(RUTA_USUARIOS, JSON.stringify(usuarios, null, 2));
        res.json({ success: true, message: 'Usuario creado.' });
    } catch (err) {
        console.error('❌ Error guardando usuario:', err);
        res.status(500).json({ error: 'Error interno.' });
    }
});

// Estado conexión
app.get('/status', (req, res) => {
    const { text1: usuario, text2: contraseña } = req.query;
    const usuarioObj = usuarios.find(u => u.usuario === usuario && u.contraseña === contraseña);
    if (!usuarioObj) return res.status(403).json({ error: 'Credenciales incorrectas.' });

    const estado = estadosClientes[usuario] || {};
    res.json({ conectado: estado.conectado || false });
});

// --- API IA independiente ---
app.post('/preguntar-ia', async (req, res) => {
    const { pregunta, contexto } = req.body;
    if (!pregunta) return res.status(400).json({ error: 'Falta el campo "pregunta".' });

    try {
        const respuesta = await responderIA(pregunta, contexto);
        res.json({ respuesta });
    } catch (err) {
        console.error("❌ Error en /preguntar-ia:", err);
        res.status(500).json({ error: "Error interno al procesar la pregunta." });
    }
});

// --- Iniciar servidor ---
const port = process.env.PORT || 3000;
const host = process.env.SERV_HOST || '0.0.0.0';
app.listen(port, host, () => console.log(`✅ Servidor escuchando en http://${host}:${port}`));
