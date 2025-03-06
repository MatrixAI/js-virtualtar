import { AbstractError } from '@matrixai/errors';

class ErrorVirtualTar<T> extends AbstractError<T> {
  static description = 'VirtualTar errors';
}

class ErrorVirtualTarUndefinedBehaviour<T> extends ErrorVirtualTar<T> {
  static description = 'You should never see this error';
}

class ErrorVirtualTarGenerator<T> extends ErrorVirtualTar<T> {
  static description = 'VirtualTar genereator errors';
}

class ErrorVirtualTarGeneratorInvalidFileName<
  T,
> extends ErrorVirtualTarGenerator<T> {
  static description = 'The provided file name is invalid';
}

class ErrorVirtualTarGeneratorInvalidStat<
  T,
> extends ErrorVirtualTarGenerator<T> {
  static description = 'The stat contains invalid data';
}

class ErrorVirtualTarGeneratorBlockSize<T> extends ErrorVirtualTarGenerator<T> {
  static description = 'The block size is incorrect';
}

class ErrorVirtualTarGeneratorEndOfArchive<
  T,
> extends ErrorVirtualTarGenerator<T> {
  static description = 'No data can come after an end-of-archive marker';
}

class ErrorVirtualTarGeneratorInvalidState<
  T,
> extends ErrorVirtualTarGenerator<T> {
  static description = 'The state is incorrect for the desired operation';
}

class ErrorVirtualTarParser<T> extends ErrorVirtualTar<T> {
  static description = 'VirtualTar parsing errors';
}

class ErrorVirtualTarParserInvalidHeader<T> extends ErrorVirtualTarParser<T> {
  static description = 'The checksum did not match the header';
}

class ErrorVirtualTarParserBlockSize<T> extends ErrorVirtualTarParser<T> {
  static description = 'The block size is incorrect';
}

class ErrorVirtualTarParserEndOfArchive<T> extends ErrorVirtualTarParser<T> {
  static description = 'No data can come after an end-of-archive marker';
}

export {
  ErrorVirtualTar,
  ErrorVirtualTarUndefinedBehaviour,
  ErrorVirtualTarGenerator,
  ErrorVirtualTarGeneratorInvalidFileName,
  ErrorVirtualTarGeneratorInvalidStat,
  ErrorVirtualTarGeneratorBlockSize,
  ErrorVirtualTarGeneratorEndOfArchive,
  ErrorVirtualTarGeneratorInvalidState,
  ErrorVirtualTarParser,
  ErrorVirtualTarParserInvalidHeader,
  ErrorVirtualTarParserBlockSize,
  ErrorVirtualTarParserEndOfArchive,
};
