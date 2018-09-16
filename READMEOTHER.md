# VirtualTar

This only exposes `extract` and `pack`.


You can `pack()` a directory and pipe it as  stream.

You can pipe a stream into `tar.extract()`.

So it just uses `tar-stream`. But what about direct access to the tar stream?

When you pack, it accepts a bunch of callbacks.

And it uses the `fs`, but we want it to accept a `fs` parameter, preferably with `VirtualFS`.

So it can be isolated, and if we can have direct access to the `tar-stream` too.

```
ignore
```

The `pack` takes `cwd` and `opts`.

Oh it takes the `fs` parameter. Cool. So it's just `xfs = opts.fs || fs`. So if we pass it a virtualfs. Then we can just create it there then!

Wait... it's still using `fs`... Oh...
Ok so all we need to do is ignore fs.

```
var vfs = require('virtualfs');
var tar = require('./index.js');

var fs = new vfs.VirtualFS;

fs.mkdirSync('/dir');
fs.writeFileSync('/dir/a', 'abc');

tar.pack('/dir', {
  fs: fs
});
```

Ok so this works. We just need to pass our vfs into it.

And everything else is fine.
