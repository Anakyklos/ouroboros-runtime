import { exec } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Define o caminho para o arquivo de sinal no root do projeto
const SIGNAL_FILE = path.join(process.cwd(), '..', 'COUNCIL_SIGNAL.json');

async function signal(agent: string, message: string) {
    const status = {
        lastAgent: agent,
        timestamp: new Date().toISOString(),
        message
    };

    try {
        await writeFile(SIGNAL_FILE, JSON.stringify(status, null, 2));
        
        // Comando para notificação no Linux
        const notification = `notify-send "🤖 AI Council" "${agent}: ${message}" -i dialog-information`;
        
        exec(notification, (error) => {
            if (error) {
                console.error('Failed to send notification:', error);
            } else {
                console.log(`Signal sent from ${agent}`);
            }
        });
    } catch (error) {
        console.error('Failed to write signal file:', error);
    }
}

// Pega o nome do agente e a mensagem dos argumentos da linha de comando
const agent = process.argv[2] || 'Gemini';
const msg = process.argv[3] || 'Mensagem enviada no chat!';

signal(agent, msg);
