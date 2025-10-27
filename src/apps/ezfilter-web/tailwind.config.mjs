/** @type {import('tailwindcss').Config} */
export default {
    content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
    theme: {
        extend: {
            colors: {
                'cloud-blue': '#00BFFF',
                'note-yellow': '#FFE55C',
                'success-green': '#90EE90',
                'off-white': '#F5F5F5',
            },
            fontFamily: {
                'serif': ['Times', 'Times New Roman', 'serif'],
                'sans': ['Inter', 'Helvetica', 'system-ui', 'sans-serif'],
            },
            animation: {
                'float': 'float 6s ease-in-out infinite',
                'drift': 'drift 8s ease-in-out infinite',
                'bounce-gentle': 'bounce-gentle 0.6s ease-out',
                'blink': 'blink 1s step-start infinite',
            },
            keyframes: {
                float: {
                    '0%, 100%': { transform: 'translateY(0px)' },
                    '50%': { transform: 'translateY(-10px)' },
                },
                drift: {
                    '0%, 100%': { transform: 'translateX(0px) translateY(0px)' },
                    '25%': { transform: 'translateX(5px) translateY(-3px)' },
                    '50%': { transform: 'translateX(-3px) translateY(-8px)' },
                    '75%': { transform: 'translateX(8px) translateY(-2px)' },
                },
                'bounce-gentle': {
                    '0%': { transform: 'scale(0.8) translateY(-20px)', opacity: '0' },
                    '50%': { transform: 'scale(1.05) translateY(-5px)', opacity: '0.8' },
                    '100%': { transform: 'scale(1) translateY(0px)', opacity: '1' },
                },
                blink: {
                    '0%, 49%': { opacity: '1' },
                    '50%, 100%': { opacity: '0' },
                },
            },
        },
    },
    plugins: [],
};