const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = 'mongodb://localhost:27017';
const client = new MongoClient(uri);

let db;

async function connect() {
  if (!db) {
    await client.connect();
    db = client.db('twitch_chat_stats');
    console.log('Connected to MongoDB');
  }
  return db;
}

module.exports = { connect };