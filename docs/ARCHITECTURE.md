# Notes Tutor – Architecture (v1)

## Overview
A chapter/tests/exam-based AI tutor system where:
- Admin uploads chapters/tests/exam (PDF/Image)
- Text is extracted (PDF.js → OCR.space fallback)
- Chapters/tests/exam are chunked and stored
- Students ask keyword-based questions
- Ai is trained to to improve answerring
- Answers are grounded in uploaded notes/tests/exam and supported externally
- predicts question paper
- exam Prediction  =currrent year tests  +previose papers +notes+AI
- test prediction=AI +previous tests+Chapter/topics
- MyInstitution(4 tests duribg the year the Final Exam)
- High Schools(4term, the 4th contains Examination)in south Africa

## Current Storage
- Supabase PostgreSQL (see DATA_MODEL.md)

## AI Layer
- LLM: Groq (OpenAI-compatible)
- ocr
- Model: llama-3.1-8b-instant

┌─────────────────────────────────────────────────────────────────────────────┐
│                        AI TRAINING DATA FLOW                                │
└─────────────────────────────────────────────────────────────────────────────┘

Step 1: EXAM PAPERS ──► Step 2: QUESTION BANK ──► Step 3: TRAINING DATA
        ↓                       ↓                           ↓
   Upload PDF             Extract Questions          Store Q&A pairs
   Process with OCR       Save to database          For AI fine-tuning
        ↓                       ↓                           ↓
   [Exam Paper]          [Question Bank]           [Training Dataset]


Step 4: STUDENT INTERACTIONS ──► Step 5: FEEDBACK LOOP ──► Step 6: SMARTER AI
        ↓                           ↓                           ↓
   Student asks Q            Track which answers        AI learns from
   AI responds               helped the student         past successes
        ↓                           ↓                           ↓
   [Chat Log]               [Feedback Data]           [Improved Answers]


Step 7: PATTERN RECOGNITION ──► Step 8: PREDICTIONS
        ↓                           ↓
   Analyze question          Predict what will
   patterns across           appear in future
   multiple exams            exams

   ┌─────────────────────────────────────────────────────────────────┐
│                    FOR EACH QUESTION                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Question: "What is the OSI Model?"                            │
│                                                                  │
│   ┌─────────────────────────┐    ┌─────────────────────────┐    │
│   │  exam_question_bank     │    │  ai_training_data       │    │
│   ├─────────────────────────┤    ├─────────────────────────┤    │
│   │ • Used for quizzes      │    │ • Used for AI learning  │    │
│   │ • Used for predictions  │    │ • Helps answer student  │    │
│   │ • Tracks usage          │    │   questions             │    │
│   │ • Stores metadata       │    │ • Builds knowledge base │    │
│   └─────────────────────────┘    └─────────────────────────┘    │
│                    ↓                           ↓                 │
│              BOTH TABLES GET THE SAME QUESTION!                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                    QUESTION PREDICTOR - SOURCES                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   SOURCE 1: CHAPTER CHUNKS (Current Material)                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ • Extract key concepts from chapter content                         │   │
│   │ • Identify important topics and definitions                         │   │
│   │ • Find key sentences and important phrases                          │   │
│   │ • Understand what the chapter actually teaches                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                      +                                      │
│   SOURCE 2: EXAM QUESTION BANK (Historical Patterns)                        │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ • Analyze past exam questions                                       │   │
│   │ • Identify frequently tested topics                                 │   │
│   │ • Understand difficulty distribution                                │   │
│   │ • See common question types                                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                      =                                      │
│   RESULT: AI-POWERED PREDICTIONS                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Questions that are:                                                 │   │
│   │ • Answerable from chapter content                                   │   │
│   │ • Similar difficulty to past exams                                  │   │
│   │ • Focused on frequently tested topics                               │   │
│   │ • Realistic for future exams                                        │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
1. Click "Exam Study" in Sidebar
         ↓
2. Study Planner Page
   - Select Module
   - Choose Chapters
   - Set Exam Date
   - Choose Intensity (Light/Moderate/Intense)
         ↓
3. AI analyzes:
   - Days until exam
   - Past exam patterns
   - Selected chapters
         ↓
4. Generates Personalized Plan:
   - Daily study schedule
   - Priority chapters
   - Time allocation
   - Practice strategy
         ↓
5. Redirects to Exam Study Page
   - Shows AI predictions
   - Practice questions
   - Study plan
   - Quizzes
   - Exam tips

   -must pick also topics,produce possible question that can come out  in exam, using previous test, exams, notes
   - must also predict possible 