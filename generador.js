(function () {
  'use strict';

  var form = document.getElementById('form-generador');
  var promptInput = document.getElementById('prompt-imagen');
  var boton = document.getElementById('boton-generar');
  var estado = document.getElementById('estado-generador');
  var resultado = document.getElementById('resultado-generador');
  var imagen = document.getElementById('imagen-generada');
  var descarga = document.getElementById('descargar-imagen');

  if (!form || !promptInput || !boton) return;

  function mostrarEstado(texto, esError) {
    estado.textContent = texto || '';
    estado.className = 'estado' + (esError ? ' estado-error' : '');
  }

  function nombreArchivo(prompt) {
    var base = prompt
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return (base || 'imagen') + '.png';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var prompt = promptInput.value.trim();
    if (!prompt) {
      mostrarEstado('Escribe una descripción para generar la imagen.', true);
      promptInput.focus();
      return;
    }

    boton.disabled = true;
    resultado.hidden = true;
    mostrarEstado('Generando imagen… esto puede tardar unos segundos.', false);

    fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: prompt }),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.data.image) {
          throw new Error((result.data && result.data.error) || 'No se pudo generar la imagen.');
        }
        imagen.src = result.data.image;
        imagen.alt = prompt;
        descarga.href = result.data.image;
        descarga.download = nombreArchivo(prompt);
        resultado.hidden = false;
        mostrarEstado('Imagen generada.', false);
      })
      .catch(function (error) {
        mostrarEstado(error.message || 'No se pudo generar la imagen.', true);
      })
      .finally(function () {
        boton.disabled = false;
      });
  });
})();
