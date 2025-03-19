// Each block in a tar file must be exactly 512 bytes
export const BLOCK_SIZE = 512;

// A standard header can fit a path with size 255 bytes before an extended
// header is needed to store the additional data.
export const STANDARD_PATH_SIZE = 255;

// Magic values to indicate a header being a valid tar header
export const USTAR_NAME = 'ustar';
export const USTAR_VERSION = '00';

// Offset for each section of a standard ustar header
export const HEADER_OFFSET = {
  FILE_NAME: 0,
  FILE_MODE: 100,
  OWNER_UID: 108,
  OWNER_GID: 116,
  FILE_SIZE: 124,
  FILE_MTIME: 136,
  CHECKSUM: 148,
  TYPE_FLAG: 156,
  LINK_NAME: 157,
  USTAR_NAME: 257,
  USTAR_VERSION: 263,
  OWNER_USERNAME: 265,
  OWNER_GROUPNAME: 297,
  DEVICE_MAJOR: 329,
  DEVICE_MINOR: 337,
  FILE_NAME_PREFIX: 345,
};

// Offset for each section of a standard ustar header
export const HEADER_SIZE = {
  FILE_NAME: 100,
  FILE_MODE: 8,
  OWNER_UID: 8,
  OWNER_GID: 8,
  FILE_SIZE: 12,
  FILE_MTIME: 12,
  CHECKSUM: 8,
  TYPE_FLAG: 1,
  LINK_NAME: 100,
  USTAR_NAME: 6,
  USTAR_VERSION: 2,
  OWNER_USERNAME: 32,
  OWNER_GROUPNAME: 32,
  DEVICE_MAJOR: 8,
  DEVICE_MINOR: 8,
  FILE_NAME_PREFIX: 155,
};
