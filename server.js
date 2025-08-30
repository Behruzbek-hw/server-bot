const mineflayer = require('mineflayer');
const express = require('express');
const WebSocket = require('ws');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 8000;

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));
app.use(express.json());

// MongoDB ulanish
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Bot schema (model)
const BotSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  server: {
    host: String,
    port: Number
  },
  reloginInterval: { type: Number, default: 0 }
});

const BotModel = mongoose.model('Bot', BotSchema);

const bots = new Map();

async function loadBots() {
  try {
    const botDocs = await BotModel.find();
    botDocs.forEach(botConfig => {
      console.log(`Starting bot: ${botConfig.username}`);
      createBot(botConfig);
    });
    broadcast({ type: 'bots', bots: botDocs });
  } catch (err) {
    console.error('Error loading bots from DB:', err);
  }
}

async function addBotToDB(botConfig) {
  try {
    const newBot = new BotModel(botConfig);
    await newBot.save();
    console.log('Bot saved to DB:', botConfig.username);
  } catch (err) {
    console.error('Error saving bot to DB:', err);
  }
}

async function removeBotFromDB(username) {
  try {
    await BotModel.deleteOne({ username });
    console.log('Bot removed from DB:', username);
  } catch (err) {
    console.error('Error removing bot from DB:', err);
  }
}

async function updateBotInDB(username, updates) {
  try {
    await BotModel.updateOne({ username }, updates);
    console.log('Bot updated in DB:', username);
  } catch (err) {
    console.error('Error updating bot in DB:', err);
  }
}

function createBot(botConfig) {
  const options = {
    host: botConfig.server.host,
    port: botConfig.server.port,
    username: botConfig.username,
    password: botConfig.password || undefined,
    version: '1.20.1'
  };

  const bot = mineflayer.createBot(options);
  bots.set(botConfig.username, bot);

  let reloginTimer;
  let antiAfkInterval;

  bot.on('login', () => {
    broadcast({ type: 'status', username: bot.username, status: 'logged in' });
    
    if (botConfig.reloginInterval && botConfig.reloginInterval > 0) {
      reloginTimer = setTimeout(() => {
        broadcast({ type: 'status', username: bot.username, status: 'Scheduled relogin' });
        bot.quit();
      }, botConfig.reloginInterval * 60 * 1000);
    }
  });

  bot.on('spawn', () => {
    broadcast({ type: 'status', username: bot.username, status: 'spawned' });
    
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
    
    setTimeout(async () => {
      const existingBot = await BotModel.findOne({ username: bot.username });
      if (existingBot && existingBot.reloginInterval > 0) {
        console.log(`Attempting to reconnect bot: ${bot.username}`);
        createBot(existingBot);
      }
    }, 5000);
  });

  bot.on('packetError', (err, packet) => {
    console.error(`Packet error for ${bot.username}:`, err, packet);
    broadcast({ type: 'status', username: bot.username, status: `packet error: ${err.message}` });
  });

  return bot;
}

async function stopBot(username) {
  const bot = bots.get(username);
  if (bot) {
    await updateBotInDB(username, { reloginInterval: 0 });
    bot.quit();
    bots.delete(username);
    broadcast({ type: 'status', username, status: 'stopped' });
    const allBots = await BotModel.find();
    broadcast({ type: 'bots', bots: allBots });
  }
}

async function removeBot(username) {
  const bot = bots.get(username);
  if (bot) {
    bot.quit();
    await removeBotFromDB(username);
    bots.delete(username);
    const allBots = await BotModel.find();
    broadcast({ type: 'bots', bots: allBots });
  }
}

function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

wss.on('connection', ws => {
  console.log('New WebSocket connection established');
  (async () => {
    const allBots = await BotModel.find();
    ws.send(JSON.stringify({ type: 'bots', bots: allBots }));
  })();

  ws.on('message', async message => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'addBot') {
        if (await BotModel.countDocuments() >= 10) {
          ws.send(JSON.stringify({ type: 'error', message: 'Maximum 10 bots allowed' }));
          return;
        }
        const botConfig = { 
          username: data.username, 
          password: data.password, 
          server: { host: data.server.host, port: data.server.port },
          reloginInterval: data.reloginInterval || 0
        };
        await addBotToDB(botConfig);
        createBot(botConfig);
        const allBots = await BotModel.find();
        broadcast({ type: 'bots', bots: allBots });
      } else if (data.type === 'removeBot') {
        await removeBot(data.username);
      } else if (data.type === 'sendCommand') {
        const bot = bots.get(data.username);
        if (bot) {
          bot.chat(data.command);
          broadcast({ type: 'status', username: data.username, status: `sent command: ${data.command}` });
        }
      } else if (data.type === 'stopBot') {
        await stopBot(data.username);
      }
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

mongoose.connection.once('open', () => {
  loadBots();
});

// Serverni faol tutish uchun ping endpoint
app.get('/ping', (req, res) => {
  res.status(200).send('Server is awake');
});

// Serverni faol tutish uchun health endpoint (eski)
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});
