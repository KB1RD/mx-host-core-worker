const webpack = require('webpack');
const path = require('path');
const env = require('yargs').argv.env; // use --env with webpack 2
const pkg = require('./package.json');

let libraryName = pkg.name;

let outputFile, mode;
let entry = __dirname + '/src/index.ts';

switch (env) {
  case 'build':
    mode = 'production';
    outputFile = libraryName + '.min.js';
    break;
  case 'browserworker':
    mode = 'production';
    outputFile = libraryName + '-browserworker.min.js';
    entry = __dirname + '/src/browserworker.ts';
    break;
  case 'sharedworker':
    mode = 'production';
    outputFile = libraryName + '-sharedworker.min.js';
    entry = __dirname + '/src/sharedworker.ts';
    break;
  case 'serviceworker':
    mode = 'production';
    outputFile = libraryName + '-serviceworker.min.js';
    entry = __dirname + '/src/serviceworker.ts';
    break;
  default:
    mode = 'development';
    outputFile = libraryName + '.js';
}

const config = {
  mode,
  entry,
  devtool: 'source-map',
  output: {
    path: __dirname + '/dist',
    filename: outputFile,
    library: libraryName,
    libraryTarget: 'umd',
    umdNamedDefine: true,
    globalObject: "typeof self !== 'undefined' ? self : this"
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'babel-loader',
        exclude: /(node_modules)/
      },
      {
        test: /\.ts$/,
        loader: 'eslint-loader',
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    modules: [path.resolve('./node_modules'), path.resolve('./src')],
    extensions: ['.json', '.ts', '.js']
  }
};

module.exports = config;
