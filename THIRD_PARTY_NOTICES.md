# Third-party notices

The Do It All Claude Code source depends on third-party software. Most of it is development-only
(build, test and type tooling) and is not distributed. The one runtime dependency that is bundled
into shipped artifacts is the dashboard's web framework, listed below. When the built dashboard
assets are distributed, this notice is distributed with them.

---

## Vue.js (`vue`)

- Version: 3.5.44
- License: MIT
- Project: https://github.com/vuejs/core

Vue is compiled into the dashboard's bundled JavaScript (`packages/dashboard/dist`). The MIT license
and its copyright notice are reproduced below.

```
The MIT License (MIT)

Copyright (c) 2013-present, Yuxi (Evan) You

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
