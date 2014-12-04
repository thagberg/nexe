var async      = require("async"),
outcome        = require("outcome"),
mkdirp         = require("mkdirp"),
request        = require("request"),
path           = require("path"),
fs             = require("fs"),
ncp            = require("ncp").ncp,
ProgressBar    = require("progress"),
child_process  = require("child_process"),
glob           = require("glob"),
bundle         = require("./bundle"),
os             = require("os"),
targz          = require('tar.gz'),
spawn          = child_process.spawn;


var _log     = require("./log"),
_monkeypatch = require("./monkeypatch");

var isWin = /^win/.test(process.platform);

/**
 */

exports.compile = function (options, complete) {

	var nodeCompiler, nexeEntryPath;

	async.waterfall([

		/**
		 * first download node
		 */

		function downloadNode (next) {
			_downloadNode(options.nodeVersion, options.nodeTempDir, next);
		},

		/**
		 * bundle the application into one script
		 */

		function combineProject (nc, next) {
			nodeCompiler = nc;
			_log("bundle %s", options.input);
			bundle(options.input, next);
		},

		/**
		 * write the bundle to the lib directory of the target node version
		 */

		function writeBundle (source, next) {
			bundlePath = path.join(nodeCompiler.dir, "lib", "nexe.js");
			_log("bundle -> %s", bundlePath);
            _log("Investigating ENOENT");

			//Remove all non-ascii code from sources
			source = source.replace(/[^\x00-\x7F]/g, "");
			// same path as all the other JS files
			fs.writeFile(bundlePath, source, next);
            _log("This worked ok");
		},

		/**
		 * monkeypatch some files so that the nexe.js file is loaded when the app runs
		 */

		function monkeyPatchNodeConfig (next) {
			_monkeyPatchNodeConfig(nodeCompiler, next);
		},

		/**
		 * monkeypatch node.cc to prevent v8 and node from processing CLI flags
		 */
		function monkeyPatchNodeCc (next) {
			if (options.flags) {
				_monkeyPatchMainCc(nodeCompiler, next);
			} else {
				next();
			}
		},

		/**
		 * compile the node application
		 */

		function makeExe (next) {
			_log("make");
			nodeCompiler.make(next);
		},

		/**
		 */

		function makeOutputDirectory (next) {
			mkdirp(path.dirname(options.output), function(){ next(); });
		},

		/**
		 */

		function copyBinaryToOutput (next) {
			_log("cp %s %s", nodeCompiler.releasePath, options.output);
			ncp(nodeCompiler.releasePath, options.output, next);
		}
	], complete);
}

/**
 */

function _downloadNode (version, directory, complete) {

	var nodeFileDir = path.resolve(path.join(process.cwd(), directory, version)),
	nodeFilePath    = path.resolve(path.join(nodeFileDir, "node-" + version + ".tar.gz"));


	// might already be downloaded, and unzipped
	if (_getNodeCompiler(nodeFileDir, complete)) {
		return;
	}


	async.waterfall([

		/**
		 * first make the directory where the zip file will live
		 */

		function makeDirectory (next) {
			mkdirp.sync(path.dirname(nodeFilePath));
			next();
		},

		/**
		 * download node into the target directory
		 */

		function downloadNode (next) {
			if (fs.existsSync(nodeFilePath)) return next();

			var url, prefix = "http://nodejs.org/dist";

			// pick which url depending on the version
			if (version === "latest") {
				url = prefix + "/node-" + version + ".tar.gz";
			} else {
				url = prefix + "/v" + version + "/node-v" + version + ".tar.gz";
			}

			_log("downloading %s", url);

			var output = fs.createWriteStream(nodeFilePath, { "flags": "w+" });

			// need to set user-agent to bypass some corporate firewalls
			var requestOptions = {
				url: url,
				headers: {
					"User-Agent": "Node.js"
				}
			}

			_logProgress(request(requestOptions)).pipe(output);

			output.on("close", function () { next(); });
		},

		/**
		 * unzip in the same directory
		 */

		function unzipNodeTarball (next) {
			if(isWin) {
				_log("Extracting the .tar.gz.");
				new targz().extract(nodeFilePath, nodeFileDir, next);
			} else {
				var cmd = ["tar", "-xf", nodeFilePath, "-C", nodeFileDir];
				_log(cmd.join(" "));

				var tar = spawn(cmd.shift(), cmd);
				tar.stdout.pipe(process.stdout);
				tar.stderr.pipe(process.stderr);

				tar.on("close", function () { next(); })
			}
		},

		/**
		 * return the compiler object for the node version
		 */

		function (next) {
			_getNodeCompiler(nodeFileDir, next)
		},

	], complete);
}

/**
 */

function _getNodeCompiler (nodeFileDir, complete) {
	var dir = _getFirstDirectory(nodeFileDir);

	if (dir) {
		if(isWin) {
			complete(null, {
				dir: dir,
				version: path.basename(nodeFileDir),
				releasePath: path.join(dir, "Release", "node.exe"),
				make: function(next) {
					var vcbuild = spawn("vcbuild.bat", ["nosign", "release", "x64"], { cwd: dir });
					vcbuild.stdout.pipe(process.stdout);
					vcbuild.stderr.pipe(process.stderr);
					vcbuild.on("close", function() {
						next();
					});
				}
			});
		} else {
			complete(null, {
				dir: dir,
				version: path.basename(nodeFileDir),
				releasePath: path.join(dir, "out", "Release", "node"),
				make: function (next) {
					var configure = spawn("./configure", [], { cwd: dir });
					configure.stdout.pipe(process.stdout);
					configure.stderr.pipe(process.stderr);
					configure.on("close", function () {
						var platformMake = "make";
						if (os.platform().match(/bsd$/) != null) {
							platformMake = "gmake";
						}
						var make = spawn(platformMake, [], { cwd: dir });
						make.stdout.pipe(process.stdout);
						make.stderr.pipe(process.stderr);
						make.on("close", function () {
							next();
						});
					})
				}
			});
		}
		return true;
	}

	return false;
}

/**
 */

function _monkeyPatchNodeConfig (compiler, complete) {
	async.waterfall([

		/**
		 * monkeypatch the gyp file to include the nexe.js file
		 */

		function (next) {
			_monkeyPatchGyp(compiler, next)
		},

		/**
		 * monkeypatch main entry point 
		 */

		function (next) {
			_monkeyPatchMainJs(compiler, next)
		}

	], complete);
}

/**
 */

function _monkeyPatchGyp (compiler, complete) {

	var gypPath = path.join(compiler.dir, "node.gyp");

	_monkeypatch(
		gypPath, 
		function (content) {
			return ~content.indexOf("nexe.js");
		},
		function (content, next) {
			next(null, content.replace("'lib/fs.js',", "'lib/fs.js', 'lib/nexe.js', "))
		},
		complete
	)
}

/**
 */

function _monkeyPatchMainJs (compiler, complete) {
	var mainPath = path.join(compiler.dir, "src", "node.js");

	_monkeypatch(
		mainPath, 
		function (content) {
			return ~content.indexOf("nexe");
		},
		function (content, next) {
			next(null, content.replace(/\(function\(process\) \{/,'(function(process) {\n  process._eval = \'require("nexe");\';\n  process.argv.unshift("node");\n'))
		},
		complete
	);
}

/**
 */

function _monkeyPatchMainCc(compiler, complete) {
	var mainPath = path.join(compiler.dir, "src", "node.cc");
	_monkeypatch(
		mainPath,
		function (content) {
			return ~content.indexOf('//  // TODO use parse opts');
		},
		function (content, next) {
			var lines = content.split('\n');
			/* These lines exist until v0.11.6 */
			var startLine = lines.indexOf('  // TODO use parse opts');
			var endLine = lines.indexOf('  option_end_index = i;');

			for (var i = startLine; i < endLine; i++) {
				lines[i] = '//' + lines[i];
			}

			lines[endLine] = '  option_end_index = 1;';
			lines = lines.join('\n');
			next(null, lines);
		},
		complete
	);
}

/**
 */

function _getFirstDirectory (dir) {
	var files = glob.sync(dir + "/*");

	for (var i = files.length; i--;) {
		var file = files[i];
		if (fs.statSync(file).isDirectory()) return file;
	}

	return false;
}

/**
 */

function _logProgress (req) {

	req.on("response", function (resp) {

		var len = parseInt(resp.headers["content-length"], 10),
		bar     = new ProgressBar("[:bar]", { 
			complete: "=", 
			incomplete: " ", 
			total: len,
			width: process.stdout.columns - 2
		});

		req.on("data", function (chunk) {
			bar.tick(chunk.length);
		});
	});

	return req;
}

