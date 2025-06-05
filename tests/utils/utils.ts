import * as tarUtils from '@/utils.js';

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
    name: tarUtils.decodeFilePath(data),
    type: tarUtils.extractString(data, 156, 1),
    mode: tarUtils.extractOctal(data, 100, 8),
    uid: tarUtils.extractOctal(data, 108, 8),
    gid: tarUtils.extractOctal(data, 116, 8),
    size: tarUtils.extractOctal(data, 124, 12),
    mtime: tarUtils.extractOctal(data, 136, 12),
    format: tarUtils.extractString(data, 257, 6),
    version: tarUtils.extractString(data, 263, 2),
  };
}

export { deepSort, splitHeaderData };
