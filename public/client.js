const qrForm = document.getElementById('qrForm');
const qrCodeDiv = document.getElementById('qrCode');
const contadorElemento = document.getElementById('contador');

let solicitudEnCurso = false;
let contadorIntervalo = null;
let pollInterval = null;

qrForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (solicitudEnCurso) return;
    solicitudEnCurso = true;

    // Limpiar y mostrar estado inicial
    qrCodeDiv.innerHTML = '';
    contadorElemento.textContent = 'Generando código QR...';
    

    const formData = new FormData(qrForm);
    const nombre = encodeURIComponent(formData.get('nombre'));
    const contrasena = encodeURIComponent(formData.get('contraseña'));

    // Función para consultar el QR periódicamente
    async function consultarQR() {
        try {
            const response = await fetch(`/generate-qr?text1=${nombre}&text2=${contrasena}`);
            const qrData = await response.text();

            if (qrData.startsWith('data:image')) {
                // Mostrar QR
                qrCodeDiv.innerHTML = `<div class="p-4 bg-white rounded-lg shadow-md" style="display: flex; justify-content: center; align-items: center;"><img src="${qrData}" alt="QR Code" style="width: 250px; height: 250px;"></div>`;
                iniciarContador(50);
            } else if (qrData === 'CONECTADO') {
                // Cliente conectado
                qrCodeDiv.innerHTML = '';
                contadorElemento.textContent = '✅ ¡Ya estás conectado!';
       
                clearInterval(pollInterval);
                if (contadorIntervalo) clearInterval(contadorIntervalo); // Limpiar el contador si está activo
                solicitudEnCurso = false;
            } else {
                // QR aún no disponible, esperar
                console.log('QR aún no listo, esperando...');
                // No se hace nada, el polling sigue
            }
        } catch (error) {
            console.error('Error consultando QR:', error);
            contadorElemento.textContent = 'Hubo un error al conectar.';
        
            clearInterval(pollInterval);
            solicitudEnCurso = false;
        }
    }

    // Llamar de inmediato y luego cada 2 segundos
    await consultarQR();
    pollInterval = setInterval(consultarQR, 2000);
});

function iniciarContador(segundos) {
    let tiempoRestante = segundos;
    contadorElemento.textContent = `Código QR válido por ${tiempoRestante} segundos`;


    if (contadorIntervalo) clearInterval(contadorIntervalo);

    contadorIntervalo = setInterval(() => {
        tiempoRestante--;
        if (tiempoRestante > 0) {
            contadorElemento.textContent = `Código QR válido por ${tiempoRestante} segundos`;
        } else {
            clearInterval(contadorIntervalo);
            qrCodeDiv.innerHTML = '<div class="text-red-500 font-bold">Código QR expirado</div>';
            contadorElemento.textContent = '';
            solicitudEnCurso = false;
            if (pollInterval) clearInterval(pollInterval);
        }
    }, 1000);
}
