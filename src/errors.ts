import { AbstractError } from '@matrixai/errors';

class ErrorTar<T> extends AbstractError<T> {
  static description = 'VirtualTar errors';
}

class ErrorVirtualTarUndefinedBehaviour<T> extends ErrorTar<T> {
  static description = 'You should never see this error';
}

class ErrorTarGenerator<T> extends ErrorTar<T> {
  static description = 'VirtualTar genereator errors';
}

class ErrorTarGeneratorInvalidFileName<T> extends ErrorTarGenerator<T> {
  static description = 'The provided file name is invalid';
}

class ErrorTarGeneratorInvalidStat<T> extends ErrorTarGenerator<T> {
  static description = 'The stat contains invalid data';
}

class ErrorTarParser<T> extends ErrorTar<T> {
  static description = 'VirtualTar parsing errors';
}

class ErrorTarParserInvalidHeader<T> extends ErrorTarParser<T> {
  static description = 'The checksum did not match the header';
}

class ErrorTarParserBlockSize<T> extends ErrorTarParser<T> {
  static description = 'The block size is incorrect';
}

class ErrorTarParserEndOfArchive<T> extends ErrorTarParser<T> {
  static description = 'No data can come after an end-of-archive marker';
}

export {
  ErrorTar,
  ErrorTarGenerator,
  ErrorVirtualTarUndefinedBehaviour,
  ErrorTarGeneratorInvalidFileName,
  ErrorTarGeneratorInvalidStat,
  ErrorTarParser,
  ErrorTarParserInvalidHeader,
  ErrorTarParserBlockSize,
  ErrorTarParserEndOfArchive,
};
