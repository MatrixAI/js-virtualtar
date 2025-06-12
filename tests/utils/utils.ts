import * as utils from '#utils.js';

const deepSort = (obj: unknown) => {
  if (Array.isArray(obj)) {
    return obj
      .map(deepSort)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  } else if (typeof obj === 'object' && obj !== null) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, deepSort(value)]),
    );
  }
  return obj;
};

function splitHeaderData(data: Uint8Array) {
  return {
    name: utils.decodeFilePath(data),
    type: utils.extractString(data, 156, 1),
    mode: utils.extractOctal(data, 100, 8),
    uid: utils.extractOctal(data, 108, 8),
    gid: utils.extractOctal(data, 116, 8),
    size: utils.extractOctal(data, 124, 12),
    mtime: utils.extractOctal(data, 136, 12),
    format: utils.extractString(data, 257, 6),
    version: utils.extractString(data, 263, 2),
  };
}

export { deepSort, splitHeaderData };
