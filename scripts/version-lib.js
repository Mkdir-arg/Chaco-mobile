// Lógica de versión compartida por `npm run version:subir` y el check de CI «Versión subida».
const fs = require('node:fs');
const path = require('node:path');

const parsear = (version) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  if (!m) throw new Error(`Versión inválida: "${version}" (se espera x.y.z)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

// -1 si a < b, 0 si iguales, 1 si a > b. Comparación numérica por parte (1.10.0 > 1.9.0).
const comparar = (a, b) => {
  const [pa, pb] = [parsear(a), parsear(b)];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
};

const subir = (version, nivel = 'patch') => {
  const [major, minor, patch] = parsear(version);
  if (nivel === 'major') return `${major + 1}.0.0`;
  if (nivel === 'minor') return `${major}.${minor + 1}.0`;
  if (nivel === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Nivel inválido: "${nivel}" (patch, minor o major)`);
};

const leerJson = (archivo) => JSON.parse(fs.readFileSync(archivo, 'utf8'));

// Versiones de los lugares que tienen que coincidir.
const versionesDe = (raiz) => {
  const lock = leerJson(path.join(raiz, 'package-lock.json'));
  return {
    'app.json': leerJson(path.join(raiz, 'app.json')).expo.version,
    'package.json': leerJson(path.join(raiz, 'package.json')).version,
    'package-lock.json': lock.version,
    'package-lock.json (packages[""])': lock.packages?.['']?.version,
  };
};

// Reemplaza solo la N-ésima aparición de `"version": "<desde>"` para no reformatear el archivo.
const reemplazarVersion = (texto, desde, hasta, aparicion) => {
  let n = 0;
  const patron = new RegExp(`("version": ")${desde.replace(/\./g, '\\.')}(")`, 'g');
  return texto.replace(patron, (todo, a, b) => {
    n += 1;
    return n === aparicion ? `${a}${hasta}${b}` : todo;
  });
};

const subirArchivos = (raiz, nivel = 'patch') => {
  const actual = versionesDe(raiz)['app.json'];
  const nueva = subir(actual, nivel);
  const editar = (nombre, apariciones) => {
    const ruta = path.join(raiz, nombre);
    let texto = fs.readFileSync(ruta, 'utf8');
    for (const aparicion of apariciones) {
      const antes = texto;
      texto = reemplazarVersion(texto, actual, nueva, aparicion);
      if (texto === antes) throw new Error(`No encontré la versión ${actual} en ${nombre}`);
    }
    fs.writeFileSync(ruta, texto);
  };
  editar('app.json', [1]);
  editar('package.json', [1]);
  // En el lock: la raíz del archivo y packages[""] (las dos primeras apariciones).
  // La segunda se busca ya sin la primera (que cambió), así que ambas son la aparición 1 de `actual`.
  editar('package-lock.json', [1, 1]);
  return { actual, nueva };
};

// Devuelve la lista de problemas (vacía = OK).
const verificarSubida = (versiones, versionBase) => {
  const problemas = [];
  if (new Set(Object.values(versiones)).size > 1) {
    const detalle = Object.entries(versiones).map(([k, v]) => `${k}=${v}`).join(', ');
    problemas.push(`Las versiones no coinciden: ${detalle}`);
  }
  const version = versiones['app.json'];
  if (comparar(version, versionBase) <= 0) {
    problemas.push(`La versión ${version} no es mayor que la de la rama base (${versionBase})`);
  }
  return problemas;
};

module.exports = { parsear, comparar, subir, versionesDe, subirArchivos, verificarSubida };
