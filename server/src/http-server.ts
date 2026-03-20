import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express from 'express';
import cors from 'cors';
import path from 'path';
import { existsSync } from 'fs';
import authRoutes from './routes/auth';
import sketchRoutes from './routes/sketches';
import collaboratorRoutes from './routes/collaborators';
import { wss, startWsServer } from './ws-server';
import { opentdfService } from './services/opentdf.service';

const app = express();
const HTTP_PORT = process.env.HTTP_PORT;

app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN,
  credentials: true,
}));

app.use('/api/auth', authRoutes);
app.use('/api/sketches', sketchRoutes);
app.use('/api/sketches', collaboratorRoutes);

// Serve client static build in production
const publicDir = path.join(__dirname, '../public');
const indexPath = path.join(publicDir, 'index.html');

if (existsSync(indexPath)) {
  app.use(express.static(publicDir));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(indexPath);
  });
} else {
  app.get('/', (_req, res) => {
    res.send('Skedoodle HTTP API is running!');
  });
}

export const startServer = () => {
  app.listen(HTTP_PORT, () => {
    console.log(`HTTP server running on http://localhost:${HTTP_PORT}`);
  });
  startWsServer();
  // Initialize OpenTDF namespace and attribute (non-blocking)
  opentdfService.ensureNamespaceAndAttribute().catch(err =>
    console.warn('[OpenTDF] Init failed (will retry on first use):', err)
  );
};

export { app, wss };

startServer();