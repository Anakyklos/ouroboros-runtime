import { useState, useEffect, useRef } from 'react';

export function useTypewriter(text: string, speed = 10, isActive = true) {
    const [displayedText, setDisplayedText] = useState('');
    const index = useRef(0);

    useEffect(() => {
        // If not active, show full text immediately
        if (!isActive) {
            setDisplayedText(text);
            index.current = text.length;
            return;
        }

        // If text is reset or changed completely (start over logic could go here,
        // but for now we assume appending or stable target)
        if (text.length < index.current) {
            index.current = 0;
            setDisplayedText('');
        }

        // If we already match, do nothing
        if (index.current >= text.length) {
            return;
        }

        const interval = setInterval(() => {
            if (index.current < text.length) {
                // Add minimal chunk (randomize slightly for realism?)
                // For now, simple 1 char per tick or speed dependent
                const charsToAdd = 1;
                const nextIndex = Math.min(index.current + charsToAdd, text.length);
                setDisplayedText(text.slice(0, nextIndex));
                index.current = nextIndex;
            } else {
                clearInterval(interval);
            }
        }, speed);

        return () => clearInterval(interval);
    }, [text, speed, isActive]);

    return displayedText;
}
