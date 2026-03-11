import { WebSocket } from 'ws';

const WS_URL = 'ws://127.0.0.1:7777/rpc-ws';
const API_KEY = 'ouroboros_dev_key';

console.log(`Connecting to ${WS_URL}...`);

const ws = new WebSocket(WS_URL, {
    headers: {
        'x-api-key': API_KEY
    }
});

ws.onopen = () => {
    console.log('Connected!');
    
    const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: {}
    };
    
    console.log('Sending request:', JSON.stringify(request));
    ws.send(JSON.stringify(request));
};

ws.onmessage = (event: any) => {
    console.log('Received response:', event.data);
    process.exit(0);
};

ws.onerror = (error: any) => {
    console.error('WebSocket error:', error);
    process.exit(1);
};

ws.onclose = () => {
    console.log('Connection closed');
};

// Timeout after 5 seconds
setTimeout(() => {
    console.error('Test timed out');
    process.exit(1);
}, 5000);
