# MediaPipe Motion Analysis Prototype

A browser-based rehabilitation motion analysis prototype built with JavaScript, p5.js, MediaPipe Pose, MediaPipe Hands and Canvas.

The project reads webcam input, detects body or hand landmarks, measures joint/hand movement metrics, counts repetitions and compares the selected exercise with a reference video panel.

## Features

- Webcam-based real-time motion tracking
- MediaPipe Pose support for arm and leg exercises
- MediaPipe Hands support for hand rehabilitation exercises
- Joint angle measurement and repetition counting
- Exercise selector and search panel
- Reference video area with overlay canvas
- Session metric collection for exercise, reps, ROM range and duration
- Browser-only implementation without a backend

## Included exercises

- Bicep Curl
- Squat
- Finger Extension
- Finger Spread
- Wrist Flexion

## Tech Stack

- HTML
- CSS
- JavaScript
- p5.js
- MediaPipe Pose
- MediaPipe Hands
- Canvas API

## Folder Structure

```txt
mediapipe-motion-analysis/
├── index.html
├── css/
│   └── style.css
├── js/
│   └── app.js
├── videos/
│   ├── bicep_ref.mp4
│   ├── squat_ref.mp4
│   ├── finger_ext_ref.mp4
│   ├── finger_spread_ref.mp4
│   └── wrist_flexion_ref.mp4
└── README.md
Reference video files are intentionally excluded from the public repository.  
To use the reference video panel locally, place your own videos inside the `videos/` folder using the filenames listed in `videos/README.md`.
```

## How to Run Locally

Because the project uses browser camera access and local video assets, run it through a local HTTP server instead of opening `index.html` directly.

```bash
py -m http.server 8000
```

Then open:

```txt
http://localhost:8000
```

Allow camera permission when the browser asks for it.

## Notes

This is an experimental prototype, not a medical device. It is intended for learning, motion-tracking experimentation and rehabilitation-oriented UI prototyping.

## Author

Developed by Melih Gönülal.
