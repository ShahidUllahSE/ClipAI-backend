// import { createApp } from './app'
// import { env } from './config'
// import { connectDatabase, disconnectDatabase } from './database/connection'
// import { seedAdminUser } from './database/seed'

// async function bootstrap() {
//   await connectDatabase()
//   await seedAdminUser()

//   const app = createApp()
//   const server = app.listen(env.PORT, () => {
//     console.log(`ClipAI API running on http://localhost:${env.PORT}`)
//     console.log(`Environment: ${env.NODE_ENV}`)
//   })

//   const shutdown = async (signal: string) => {
//     console.log(`${signal} received. Shutting down...`)
//     server.close(async () => {
//       await disconnectDatabase()
//       process.exit(0)
//     })
//   }

//   process.on('SIGINT', () => void shutdown('SIGINT'))
//   process.on('SIGTERM', () => void shutdown('SIGTERM'))
// }

// bootstrap().catch((error) => {
//   console.error('Failed to start server:', error)
//   process.exit(1)
// })

import dns from "dns";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

import { createApp } from "./app";
import { env } from "./config";
import { connectDatabase, disconnectDatabase } from "./database/connection";
import { seedAdminUser } from "./database/seed";

async function bootstrap() {
  await connectDatabase();
  await seedAdminUser();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`ClipAI API running on http://localhost:${env.PORT}`);
    console.log(`Environment: ${env.NODE_ENV}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received. Shutting down...`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
