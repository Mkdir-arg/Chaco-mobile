// Display mode detects how this window was opened, not every installation
// elsewhere on the device. Safari also exposes navigator.standalone.
export const getInstallationHelp = ({ navigator: nav = {}, matchMedia } = {}) => {
  if (nav.standalone === true || matchMedia?.('(display-mode: standalone)')?.matches
    || matchMedia?.('(display-mode: minimal-ui)')?.matches) return null;
  const ua = nav.userAgent || '';
  const ios = /iPad|iPhone|iPod/i.test(ua)
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (ios) return {
    device: 'iPhone o iPad',
    steps: [
      'Abrí esta página en Safari.',
      'Tocá Compartir (el cuadrado con una flecha hacia arriba). Si no aparece, abrí el menú de Safari.',
      'Elegí “Agregar a inicio” o “Añadir a pantalla de inicio”.',
      'Si aparece “Abrir como app web”, dejalo activado. Tocá “Agregar”.',
      'Abrí DATAÑACH desde el nuevo ícono de la pantalla de inicio.',
    ],
  };
  if (/Android/i.test(ua)) return {
    device: 'Android',
    steps: [
      'Abrí esta página en Chrome.',
      'Tocá el menú de los tres puntos (⋮).',
      'Elegí “Instalar aplicación” o “Agregar a la pantalla principal”. Si te ofrece instalarla, elegí “Instalar”.',
      'Confirmá la instalación y abrí DATAÑACH desde su nuevo ícono.',
    ],
  };
  return {
    device: 'tu computadora',
    steps: [
      'Abrí esta página en Chrome o Edge.',
      'Buscá el ícono de instalación en la barra de direcciones o la opción “Instalar DATAÑACH” en el menú del navegador.',
      'Confirmá la instalación y abrí DATAÑACH desde su nuevo acceso.',
    ],
  };
};
