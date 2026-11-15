import { createApp } from './app.ts';
import { ensureSetup } from './setup.ts';

ensureSetup();

const app = createApp();
const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`Innehav API lyssnar på http://localhost:${port}`));
