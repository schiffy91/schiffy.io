let fs = require("fs");
let execSync = require("child_process").execSync;

// Parse arguments
let args = process.argv.slice(2);
if (!Array.isArray(args) || args.length != 5) {
	throw "usage: resize input_path resize_percent quality max_size output_path";
}

let inputPath = args[0];
let resizePercent = args[1]
let quality = args[2];
let maxSize = args[3];
let outputPath = args[4];

fs.readdirSync(inputPath).forEach(file => {
	try {
		execSync(`convert '${inputPath}/${file}' -resize ${resizePercent} -quality ${quality} -define jpeg:extent=${maxSize} '${outputPath}/${file}'`, { stdio: 'inherit' });
	} catch (e) {
		console.error(`Failed to resize ${file}: ${e}`);
	}
});