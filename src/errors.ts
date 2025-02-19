import { AbstractError } from '@matrixai/errors';

class ErrorVirtualTar<T> extends AbstractError<T> {
  static description = 'VirtualTar errors';
}

class ErrorVirtualTarUndefinedBehaviour<T> extends ErrorVirtualTar<T> {
  static description = 'You should never see this error';
}

class ErrorVirtualTarInvalidFileName<T> extends ErrorVirtualTar<T> {
  static description = 'The provided file name is invalid';
}

class ErrorVirtualTarInvalidHeader<T> extends ErrorVirtualTar<T> {
  static description = 'The header has invalid data';
}

class ErrorVirtualTarInvalidStat<T> extends ErrorVirtualTar<T> {
  static description = 'The stat contains invalid data';
}

class ErrorVirtualTarBlockSize<T> extends ErrorVirtualTar<T> {
  static description = 'The block size is incorrect';
}

class ErrorVirtualTarEndOfArchive<T> extends ErrorVirtualTar<T> {
  static description = 'No data can come after an end-of-archive marker';
}

export {
  ErrorVirtualTar,
  ErrorVirtualTarUndefinedBehaviour,
  ErrorVirtualTarInvalidFileName,
  ErrorVirtualTarInvalidHeader,
  ErrorVirtualTarInvalidStat,
  ErrorVirtualTarBlockSize,
  ErrorVirtualTarEndOfArchive,
};
