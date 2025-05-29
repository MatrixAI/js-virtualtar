# js-virtualtar

VirtualTar is a library used to create tar files using a virtual file system or
a file tree. This library aims to provide a platform-agnostic generator-parser
pair to create tar files without the reliance on a file system.

## Installation

```sh
npm install --save @matrixai/virtualtar
```

## Usage

See the example usage in [tests](tests).

## Development

Run `nix develop`, and once you're inside, you can use:

```sh
# install (or reinstall packages from package.json)
npm install
# build the dist objects
npm run build
# run the repl (this allows you to import from ./src)
npm run tsx
# run the tests
npm run test
# lint the source code
npm run lint
# automatically fix the source
npm run lintfix
```

### Docs Generation

```sh
npm run docs
```

See the docs at: https://matrixai.github.io/js-virtualtar/

### Publishing

```sh
# npm login
npm version patch # major/minor/patch
npm run build
npm publish --access public
git push
git push --tags
```

## License

`js-virtualtar` is licensed under Apache-2.0, you may read the terms of the
license [here](LICENSE).
