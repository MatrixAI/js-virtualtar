// Each block in a tar file must be exactly 512 bytes
export const BLOCK_SIZE = 512;

// A standard header can fit a path with size 255 bytes before an extended
// header is needed to store the additional data.
export const STANDARD_PATH_SIZE = 255;

// Magic values to indicate a header being a valid tar header
export const USTAR_NAME = 'ustar';
export const USTAR_VERSION = '00';
