import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';

console.log('fastifyWebsocket:', fastifyWebsocket);
const f = Fastify();
f.register(fastifyWebsocket);
console.log('Registered');
