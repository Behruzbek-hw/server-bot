const mineflayer = require('mineflayer');
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8001;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let config = { server: { host: 'localhost', port: 25565 }, bots: [] };
const bots = new Map();

try {
  const data = fs.readFileSync('config.json', 'utf8');
  config = JSON.parse(data);
} catch (err) {
  console.error('Error reading config.json, using default config:', err);
}

function saveConfig() {
  fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
}

function createBot(botConfig) {
  const options = {
    host: config.server.host,
    port: config.server.port,
    username: botConfig.username,
    password: botConfig.password || undefined,
    version: '1.20.1' // Minecraft server versiyasini qo‘lda belgilash
  };

  const bot = mineflayer.createBot(options);
  bots.set(botConfig.username, bot);

  bot.on('login', () => {
    broadcast({ type: 'status', username: bot.username, status: 'logged in' });
  });

  bot.on('spawn', () => {
    broadcast({ type: 'status', username: bot.username, status: 'spawned' });
    setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
      }
    }, 30000);
  });

  bot.on('kicked', (reason) => {
    broadcast({ type: 'status', username: bot.username, status: `kicked: ${reason}` });
    bots.delete(bot.username);
  });

  bot.on('error', (err) => {
    broadcast({ type: 'status', username: bot.username, status: `error: ${err}` });
  });

  bot.on('end', () => {
    broadcast({ type: 'status', username: bot.username, status: 'disconnected' });
    bots.delete(bot.username);
  });

  // Chunk size xatosini aniqlash uchun qo‘shimcha xato boshqaruvi
  bot.on('packetError', (err, packet) => {
    console.error(`Packet error for ${bot.username}:`, err, packet);
    broadcast({ type: 'status', username: bot.username, status: `packet error: ${err.message}` });
  });

  return bot;
}

function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'config', config }));
  ws.send(JSON.stringify({ type: 'bots', bots: Array.from(bots.keys()) }));

  ws.on('message', message => {
    const data = JSON.parse(message);

    if (data.type === 'addBot') {
      if (config.bots.length >= 10) {
        ws.send(JSON.stringify({ type: 'error', message: 'Maximum 10 bots allowed' }));
        return;
      }
      const botConfig = { username: data.username, password: data.password, commands: [] };
      config.bots.push(botConfig);
      saveConfig();
      createBot(botConfig);
      broadcast({ type: 'bots', bots: Array.from(bots.keys()) });
    } else if (data.type === 'removeBot') {
      const bot = bots.get(data.username);
      if (bot) {
        bot.quit();
        config.bots = config.bots.filter(b => b.username !== data.username);
        saveConfig();
        broadcast({ type: 'bots', bots: Array.from(bots.keys()) });
      }
    } else if (data.type === 'sendCommand') {
      const bot = bots.get(data.username);
      if (bot) {
        bot.chat(data.command);
        broadcast({ type: 'status', username: bot.username, status: `sent command: ${data.command}` });
      }
    } else if (data.type === 'updateServer') {
      config.server.host = data.host;
      config.server.port = data.port;
      saveConfig();
      broadcast({ type: 'config', config });
    }
  });
});

// Initialize existing bots
config.bots.forEach(createBot);
