// Disposable CodeQL negative fixture. This file is never imported or executed.
const childProcess = require("node:child_process");
const http = require("node:http");
const url = require("node:url");

http.createServer((request, response) => {
  const file = url.parse(request.url, true).query.path;
  childProcess.execSync(`wc -l ${file}`);
  response.end();
});
