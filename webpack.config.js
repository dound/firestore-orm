const path = require('path')

const { LicenseWebpackPlugin } = require('license-webpack-plugin')
const webpack = require('webpack')

module.exports = {
  entry: './src/firestore.js',
  output: {
    filename: 'firestoredb.cjs',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'commonjs2'
  },
  mode: 'production',
  target: 'web',
  module: {
    rules: [
      {
        test: /\.js$/,
        use: {
          loader: 'babel-loader',
          options: {
            plugins: [
              '@babel/plugin-proposal-class-properties'
            ]
          }
        }
      }
    ]
  },
  externals: {
    '@pocketgems/schema': './schema.cjs',
    assert: './assert.cjs'
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env': {
        NODE_ENV: JSON.stringify('webpack')
      }
    }),
    new LicenseWebpackPlugin({
      outputFilename: 'firestoredb-licenses.txt',
      unacceptableLicenseTest: (licenseType) => (licenseType === 'GPL')
    })
  ]
}
