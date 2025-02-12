import * as errors from './errors';

function never(message: string): never {
  throw new errors.ErrorVirtualTarUndefinedBehaviour(message);
}

export { never };
