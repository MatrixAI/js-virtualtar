import * as tar from '@';

describe('index', () => {
  test('should have correct high-level exports', () => {
    expect('VirtualTarGenerator' in tar).toBeTrue();
    expect('VirtualTarParser' in tar).toBeTrue();
    expect('Generator' in tar).toBeTrue();
    expect('Parser' in tar).toBeTrue();
    expect('constants' in tar).toBeTrue();
    expect('errors' in tar).toBeTrue();
    expect('utils' in tar).toBeTrue();
    expect('types' in tar).toBeTrue();
  });
});
