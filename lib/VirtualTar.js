import pathNode from 'path';
import tar from 'tar-stream';

const pathJoin = (pathNode.posix) ? pathNode.posix.join : pathNode.join;

// we cannot use tar-fs
// because it works against streams
// but usually we want it to utilise an fs
// passed in as function
// so we use a constructor
// to pass in the correct fs

class VirtualTar {

  constructor (fs) {
    this._fs = fs;
  }

  pack (path, options) {
    
  }

  extract (path, options) {
    
  }

}

export default VirtualTar;
