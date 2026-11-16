import { relaunchedWithBiggerHeap } from './heap';

// The server is loaded only once the heap is the right size: a process that
// starts itself again with a bigger one shouldn't load Nest, Baileys and
// Prisma first just to pass signals on (heap.ts).
if (!relaunchedWithBiggerHeap()) void import('./server.js');
