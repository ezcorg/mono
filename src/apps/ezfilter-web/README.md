# ezfilter-web

A playful, friendly website for ezfilter - content filtering without all the chaos.

## 🎨 Design

Based on a hand-drawn sketch, this website features:
- **Black & white base** with fun color accents (blue, yellow, green)
- **Cloud character mascot** with floating animations
- **Musical notes** and playful elements
- **Cloud-shaped email popup** for waitlist signup
- **Student/non-profit friendly pricing** (free for students & non-profits, $5.99/month for others)

## 🚀 Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## 🏗️ Architecture

- **Framework**: Astro 4.0 with Tailwind CSS
- **Components**: Modular design following ezdev-web patterns
- **Animations**: CSS-based with custom keyframes
- **Email**: Integration ready for waitlist worker (rate-limited, no captcha)

## 📁 Structure

```
src/
├── components/
│   ├── CloudCharacter.astro    # Animated cloud mascot
│   ├── EmailPopup.astro        # Cloud-shaped waitlist popup
│   ├── FilterAnimation.astro   # Chaos → clean animation
│   ├── MusicalNotes.astro      # Floating musical notes
│   ├── PricingSection.astro    # Student-friendly pricing
│   └── WaitlistButton.astro    # CTA button
├── layouts/
│   └── Layout.astro            # Base layout
├── pages/
│   ├── index.astro             # Homepage
│   ├── privacy.astro           # Privacy policy
│   └── terms.astro             # Terms of service
└── styles/
    └── global.css              # Global styles & animations
```

## 🎭 Key Features

- **Responsive design** - Mobile-first approach
- **Smooth animations** - Cloud floating, note drifting, filter demo
- **Accessible** - Keyboard navigation, focus states
- **Performance optimized** - Static generation, minimal JS
- **Privacy focused** - No tracking, minimal data collection

## 🔧 Customization

### Colors
- `cloud-blue`: #00BFFF (primary accent)
- `note-yellow`: #FFE55C (musical notes)
- `success-green`: #90EE90 (success states)
- `off-white`: #F5F5F5 (text)

### Animations
- `animate-float`: Cloud character floating
- `animate-drift`: Musical notes drifting
- `animate-bounce-gentle`: Popup entrance

## 📧 Waitlist Integration

The email popup is ready to integrate with a Cloudflare Worker for waitlist management. Update the endpoint in `EmailPopup.astro`:

```javascript
const response = await fetch('/api/waitlist', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, name }),
});
```

## 🚀 Deployment

Built for static deployment on platforms like:
- Vercel
- Netlify
- Cloudflare Pages
- GitHub Pages

## 📝 License

Part of the ezdev monorepo.