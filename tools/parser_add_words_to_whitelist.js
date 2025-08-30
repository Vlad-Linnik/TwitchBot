const ChatStats = require('./msgHandlerDependencies/chatStats.js');
const fs = require('fs').promises; // Используем промис-версию fs

async function loadSmiles() {
  try {
    const data = await fs.readFile('output.txt', 'utf8');
    return data.split("\r\n").filter(smile => smile.trim() !== "");
  } catch (err) {
    console.error("Error reading file:", err);
    return [];
  }
}

async function testData() {
  const smiles = await loadSmiles();
  
  for (const smile of smiles) {
    try {
      await ChatStats.addToWhiteList(smile);
      console.log("Added to white list:", smile);
    } catch (err) {
      console.error("Error adding smile:", smile, err);
    }
  }
}

// Запуск
testData()
  .then(() => console.log("All smiles processed"))
  .catch(err => console.error("Global error:", err));