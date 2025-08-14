// Cargar variables de entorno
require('dotenv').config();

// Importar librerías
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs').promises; // Usar la versión de promesas de fs para operaciones asíncronas
const { Client, LocalAuth } = require('whatsapp-web.js');
const app = express();
// Render utiliza la variable de entorno 'PORT'. Si no está definida, usa 'SERV_PORT' o 3000.
const port = process.env.PORT || process.env.SERV_PORT || 3000;
// Usamos 'SERV_HOST' del archivo .env o '0.0.0.0' para escuchar en todas las interfaces de red, lo cual es necesario en Render
const host = process.env.SERV_HOST || '0.0.0.0';

// Configurar Express para servir archivos estáticos y procesar JSON
app.use(express.static('public'));
app.use(express.json());

// Cargar usuarios desde un archivo JSON de forma asíncrona
let usuarios = [];
fs.readFile('usuarios.json', 'utf8')
    .then(data => {
        usuarios = JSON.parse(data);
        console.log('Usuarios cargados:', usuarios.map(u => u.usuario));
    })
    .catch(() => {
        console.log('usuarios.json no existe o está vacío. Se creará al añadir usuarios.');
    });

// Objeto para almacenar los estados de los clientes (QR, conexión) y el cache de web scraping
// Las claves son los nombres de usuario
const estados = {};

// Cache en memoria para el contenido web
const webContentCache = {};
const CACHE_DURATION_MS = 3600000; // 1 hora en milisegundos

/**
 * Función para llamar a la API de Gemini y generar una respuesta de IA,
 * incluyendo la capacidad de hacer web scraping si se proporciona una URL.
 * Se ha mejorado con un cache para evitar peticiones repetidas.
 * @param {string} mensaje El mensaje del usuario en WhatsApp.
 * @param {string} contexto El contexto del negocio para la IA, que puede incluir una URL.
 * @returns {Promise<string>} La respuesta generada por la IA o un mensaje de error.
 */
async function generarRespuestaIA(mensaje, contexto) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
    let contenidoWeb = '';

    // Expresión regular para encontrar una URL en el contexto
    const urlMatch = contexto.match(/(https?:\/\/[^\s]+)/);

    if (urlMatch) {
        const paginaUrl = urlMatch[0];
        const cacheEntry = webContentCache[paginaUrl];
        const now = Date.now();

        // Verificar si el contenido está en el cache y no ha expirado
        if (cacheEntry && (now - cacheEntry.timestamp < CACHE_DURATION_MS)) {
            console.log(`Web scraping: usando contenido en cache para ${paginaUrl}`);
            contenidoWeb = cacheEntry.content;
        } else {
            // Si no hay cache o ha expirado, hacer web scraping
            try {
                console.log(`Web scraping: obteniendo contenido de ${paginaUrl}`);
                const response = await fetch(paginaUrl);
                if (response.ok) {
                    const html = await response.text();
                    // Limitar el contenido para evitar prompts muy largos
                    const textoPlano = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 1500);
                    contenidoWeb = `\n\nContenido de la web de la tienda (${paginaUrl}):\n${textoPlano}\n\n`;
                    // Guardar en el cache
                    webContentCache[paginaUrl] = {
                        content: contenidoWeb,
                        timestamp: now
                    };
                } else {
                    console.error(`Error al hacer fetch de la URL: ${response.status}`);
                }
            } catch (err) {
                console.error("Error al obtener la página web:", err);
            }
        }
    }

    const promptCompleto = `Contexto: ${contexto}${contenidoWeb}\nMensaje: ${mensaje}`;
    const body = {
        contents: [{ parts: [{ text: promptCompleto }] }]
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();
        const textoGenerado = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return textoGenerado || "No pude generar una respuesta. Por favor, inténtalo de nuevo.";
    } catch (err) {
        console.error("Error llamando a la API de Gemini:", err);
        return "Hubo un error al procesar el mensaje. Por favor, inténtalo de nuevo más tarde.";
    }
}

/**
 * Crea o inicializa un cliente de WhatsApp para un usuario específico.
 * @param {string} usuario El nombre de usuario.
 * @returns {Client} El cliente de WhatsApp.
 */
function crearCliente(usuario) {
    if (estados[usuario]?.cliente) {
        console.log(`Cliente para ${usuario} ya existe.`);
        return estados[usuario].cliente;
    }

    console.log(`Creando cliente para ${usuario}...`);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `client-${usuario}`
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    estados[usuario] = { cliente: client, qrCodeData: null, conectado: false };

    client.on('qr', qr => {
        console.log(`QR generado para ${usuario}`);
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) estados[usuario].qrCodeData = url;
        });
    });

    client.on('ready', () => {
        console.log(`✅ Cliente ${usuario} conectado`);
        estados[usuario].qrCodeData = null;
        estados[usuario].conectado = true;
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ Cliente ${usuario} desconectado. Motivo: ${reason}`);
        estados[usuario].conectado = false;
    });

    client.on('message', async message => {
        console.log(`Mensaje recibido de ${message.from}: ${message.body}`);
        const contexto = usuarios.find(u => u.usuario === usuario)?.contexto || '';
        const respuesta = await generarRespuestaIA(message.body, contexto);
        message.reply(respuesta);
    });

    client.initialize();
    return client;
}

// --- Rutas de la API Express ---

app.get('/generate-qr', (req, res) => {
    const { text1, text2 } = req.query;
    console.log(`Solicitud de QR: usuario=${text1}`);

    const usuarioObj = usuarios.find(u => u.usuario === text1 && u.contraseña === text2);
    if (!usuarioObj) {
        return res.status(403).send('Usuario o contraseña incorrectos');
    }

    crearCliente(usuarioObj.usuario);

    const estado = estados[usuarioObj.usuario];
    if (estado.conectado) {
        return res.send('CONECTADO');
    }
    if (estado.qrCodeData) {
        return res.send(estado.qrCodeData);
    }

    return res.status(503).send('QR aún no disponible, espere...');
});

app.post('/crear-usuario', async (req, res) => {
    const { usuario, contraseña, contexto } = req.body;
    console.log(`Intento de crear usuario: ${usuario}`);

    if (!usuario || !contraseña) {
        return res.status(400).json({ error: 'Faltan campos' });
    }
    if (usuarios.find(u => u.usuario === usuario)) {
        return res.status(400).json({ error: 'Usuario ya existe' });
    }

    const nuevoUsuario = { usuario, contraseña, contexto: contexto || '' };
    usuarios.push(nuevoUsuario);

    // Escribir el archivo de forma asíncrona
    try {
        await fs.writeFile('usuarios.json', JSON.stringify(usuarios, null, 2));
        console.log(`Usuario creado: ${usuario}`);
        res.json({ success: true, message: 'Usuario creado correctamente' });
    } catch (err) {
        console.error('Error al escribir el archivo de usuarios:', err);
        res.status(500).json({ error: 'Error interno al guardar el usuario' });
    }
});

app.get('/status', (req, res) => {
    const { text1, text2 } = req.query;
    const usuarioObj = usuarios.find(u => u.usuario === text1 && u.contraseña === text2);
    if (!usuarioObj) {
        return res.status(403).json({ error: 'Credenciales incorrectas' });
    }

    const estado = estados[usuarioObj.usuario] || {};
    console.log(`Estado de ${usuarioObj.usuario}: conectado=${estado.conectado || false}`);
    res.json({ conectado: estado.conectado || false });
});

// Iniciar el servidor
app.listen(port, host, () => {
    console.log(`Servidor escuchando en http://${host}:${port}`);
});
