const mineflayer = require('mineflayer');
const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Muhit o‘zgaruvchilaridan server sozlamalarini olish
let config = {
  server: {
    host: process.env.MINECRAFT_HOST || 'localhost',
    port: parseInt(process.env.MINECRAFT_PORT) || 25565
  },
  bots: []
};

// Agar muhit o‘zgaruvchilarida botlar ro‘yxati bo‘lsa, uni o‘qish
if (process.env.BOTS) {
  try {
    config.bots = JSON.parse(process.env.BOTS);
  } catch (err) {
    console.error('Error parsing BOTS environment variable:', err);
  }
}

const bots = new Map();

function createBot(botConfig) {
  const options = {
    host: config.server.host,
    port: config.server.port,
    username: botConfig.username,
    password: botConfig.password || undefined,
    version: '1.20.1' // Minecraft server versiyasi
  };

  const bot = mineflayer.createBot(options);
  bots.set(botConfig.username, bot);

  let reloginTimer;
  let antiAfkInterval;

  bot.on('login', () => {
    broadcast({ type: 'status', username: bot.username, status: 'logged in' });
    
    // Doimiy chiqib qayta kirish
    if (botConfig.reloginInterval && botConfig.reloginInterval > 0) {
      reloginTimer = setTimeout(() => {
        broadcast({ type: 'status', username: bot.username, status: 'Scheduled relogin' });
        bot.quit();
      }, botConfig.reloginInterval * 60 * 1000);
    }
  });

  bot.on('spawn', () => {
    broadcast({ type: 'status', username: bot.username, status: 'spawned' });
    
    // Anti-AFK: Sakrash va tasodifiy harakat
    antiAfkInterval = setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
        
        const directions = ['forward', 'back', 'left', 'right'];
        const randomDir = directions[Math.floor(Math.random() * directions.length)];
        bot.setControlState(randomDir, true);
        setTimeout(() => bot.setControlState(randomDir, false), 500);
        
        bot.look(Math.random() * Math.PI * 2, Math.random() * Math.PI - Math.PI / 2);
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
    if (reloginTimer) clearTimeout(reloginTimer);
    if (antiAfkInterval) clearInterval(antiAfkInterval);
    
    broadcast({ type: 'status', username: bot.username, status: 'disconnected' });
    bots.delete(bot.username);
    
    if (botConfig.reloginInterval && botConfig.reloginInterval > 0) {
      setTimeout(() => {
        createBot(botConfig);
      }, 5000);
    }
  });

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
      const botConfig = { 
        username: data.username, 
        password: data.password, 
        commands: [], 
        reloginInterval: data.reloginInterval || 0
      };
      config.bots.push(botConfig);
      createBot(botConfig);
      broadcast({ type: 'bots', bots: Array.from(bots.keys()) });
    } else if (data.type === 'removeBot') {
      const bot = bots.get(data.username);
      if (bot) {
        bot.quit();
        config.bots = config.bots.filter(b => b.username !== data.username);
        broadcast({ type: 'bots', bots: Array.from(bots.keys()) });
      }
    } else if (data.type === 'sendCommand') {
      const bot = bots narrative: {
        bot.chat(data.command);
        broadcast({ type: 'status', username: bot.username, status: `sent command: ${data.command}` });
      }
    } else if (data.type === 'updateServer') {
      config.server.host = data.host;
      config.server.port = data.port;
      broadcast({ type: 'config', config });
    }
  });
});

// Initialize existing bots
config.bots.forEach(createBot);
