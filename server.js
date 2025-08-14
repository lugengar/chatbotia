// Cargar variables de entorno
require('dotenv').config();

// Importar librerías
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js'); // Importar LocalAuth
const app = express();
// Render utiliza la variable de entorno 'PORT'. Si no está definida, usa 'SERV_PORT' o 3000.
const port = process.env.PORT || process.env.SERV_PORT || 3000;
// Usamos 'SERV_HOST' del archivo .env o '0.0.0.0' para escuchar en todas las interfaces de red, lo cual es necesario en Render
const host = process.env.SERV_HOST || '0.0.0.0';

// Configurar Express para servir archivos estáticos y procesar JSON
app.use(express.static('public'));
app.use(express.json());

// Cargar usuarios desde un archivo JSON
let usuarios = [];
try {
    usuarios = JSON.parse(fs.readFileSync('usuarios.json', 'utf8'));
    console.log('Usuarios cargados:', usuarios.map(u => u.usuario));
} catch (error) {
    console.log('usuarios.json no existe o está vacío. Se creará al añadir usuarios.');
}

// Objeto para almacenar los estados de los clientes (QR, conexión)
// Las claves son los nombres de usuario
const estados = {};

/**
 * Función para llamar a la API de Gemini y generar una respuesta de IA,
 * incluyendo la capacidad de hacer web scraping si se proporciona una URL.
 * @param {string} mensaje El mensaje del usuario en WhatsApp.
 * @param {string} contexto El contexto del negocio para la IA, que puede incluir una URL.
 * @returns {Promise<string>} La respuesta generada por la IA o un mensaje de error.
 */
async function generarRespuestaIA(mensaje, contexto) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
    let contenidoWeb = '';

    // Expresión regular para encontrar una URL en el contexto
    const urlMatch = contexto.match(/(https?:\/\/[^\s]+)/);

    // Si se encuentra una URL, intenta obtener el contenido de la página
    if (urlMatch) {
        const paginaUrl = urlMatch[0];
        try {
            console.log(`Web scraping: obteniendo contenido de ${paginaUrl}`);
            const response = await fetch(paginaUrl);
            if (response.ok) {
                // Leer el contenido de la página como texto
                const html = await response.text();
                // Aquí podrías usar una librería como 'cheerio' o 'jsdom' para
                // parsear el HTML, pero para este ejemplo simple, solo usaremos
                // una parte del texto para evitar que el prompt sea demasiado largo.
                const textoPlano = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 1500);
                contenidoWeb = `\n\nContenido de la web de la tienda (${paginaUrl}):\n${textoPlano}\n\n`;
            } else {
                console.error(`Error al hacer fetch de la URL: ${response.status}`);
            }
        } catch (err) {
            console.error("Error al obtener la página web:", err);
            // Si el web scraping falla, simplemente se ignora y se continúa con el contexto original
        }
    }

    const promptCompleto = `Contexto: ${contexto}${contenidoWeb}\nMensaje: ${mensaje}`;

    const body = {
        contents: [
            {
                parts: [
                    {
                        text: promptCompleto
                    }
                ]
            }
        ]
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
    // Si ya existe un cliente para este usuario, lo retornamos
    if (estados[usuario]?.cliente) {
        console.log(`Cliente para ${usuario} ya existe.`);
        return estados[usuario].cliente;
    }

    console.log(`Creando cliente para ${usuario}...`);

    // Usar LocalAuth para guardar la sesión del cliente
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `client-${usuario}` // Un ID único para cada usuario
        }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    // Inicializar el estado del usuario
    estados[usuario] = { cliente: client, qrCodeData: null, conectado: false };

    // Evento que se dispara cuando se genera el código QR
    client.on('qr', qr => {
        console.log(`QR generado para ${usuario}`);
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) estados[usuario].qrCodeData = url;
        });
    });

    // Evento que se dispara cuando el cliente se conecta exitosamente
    client.on('ready', () => {
        console.log(`✅ Cliente ${usuario} conectado`);
        estados[usuario].qrCodeData = null; // Limpiar el QR una vez conectado
        estados[usuario].conectado = true;
    });

    // Evento que se dispara cuando el cliente se desconecta
    client.on('disconnected', (reason) => {
        console.log(`❌ Cliente ${usuario} desconectado. Motivo: ${reason}`);
        estados[usuario].conectado = false;
        // Se podría agregar lógica para intentar reconectar aquí
    });

    // Evento que se dispara cuando se recibe un mensaje
    client.on('message', async message => {
        console.log(`Mensaje recibido de ${message.from}: ${message.body}`);
        // Obtener el contexto del usuario del JSON
        const contexto = usuarios.find(u => u.usuario === usuario)?.contexto || '';
        const respuesta = await generarRespuestaIA(message.body, contexto);
        message.reply(respuesta);
    });

    // Iniciar el cliente
    client.initialize();
    return client;
}

// --- Rutas de la API Express ---

// Ruta para generar el QR o verificar el estado de conexión
app.get('/generate-qr', (req, res) => {
    const { text1, text2 } = req.query; // text1 es usuario, text2 es contraseña
    console.log(`Solicitud de QR: usuario=${text1}`);

    const usuarioObj = usuarios.find(u => u.usuario === text1 && u.contraseña === text2);
    if (!usuarioObj) {
        return res.status(403).send('Usuario o contraseña incorrectos');
    }

    // Crea el cliente si no existe
    crearCliente(usuarioObj.usuario);

    const estado = estados[usuarioObj.usuario];
    if (estado.conectado) {
        return res.send('CONECTADO');
    }
    if (estado.qrCodeData) {
        return res.send(estado.qrCodeData);
    }

    // Si aún no se genera el QR, indicarlo
    return res.status(503).send('QR aún no disponible, espere...');
});

// Ruta para crear un nuevo usuario
app.post('/crear-usuario', (req, res) => {
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
    fs.writeFileSync('usuarios.json', JSON.stringify(usuarios, null, 2));
    console.log(`Usuario creado: ${usuario}`);

    res.json({ success: true, message: 'Usuario creado correctamente' });
});

// Ruta para verificar el estado de conexión de un usuario
app.get('/status', (req, res) => {
    const { text1, text2 } = req.query; // text1 es usuario, text2 es contraseña
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
