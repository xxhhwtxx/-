const dino = document.getElementById('dino');
const obstacle = document.getElementById('obstacle');
const scoreEl = document.getElementById('score');
const gameOverEl = document.getElementById('game-over');
const jumpBtn = document.getElementById('jump-btn');

let dinoY = 0;
let velocityY = 0;
let isJumping = false;
let obstacleX = 680;
let gameRunning = false;
let gameOver = false;
let score = 0;
let speed = 6;

const gravity = 0.8;
const jumpPower = 14;
const groundY = 20;
const dinoX = 50;

function resetGame() {
  dinoY = 0;
  velocityY = 0;
  isJumping = false;
  obstacleX = 680;
  score = 0;
  speed = 6;
  gameOver = false;
  gameRunning = true;
  gameOverEl.classList.add('hidden');
  updateUI();
}

function jump() {
  if (!gameRunning) {
    resetGame();
  }

  if (gameOver) {
    resetGame();
    return;
  }

  if (!isJumping) {
    velocityY = jumpPower;
    isJumping = true;
  }
}

function updateDino() {
  if (isJumping) {
    dinoY += velocityY;
    velocityY -= gravity;

    if (dinoY <= 0) {
      dinoY = 0;
      velocityY = 0;
      isJumping = false;
    }
  }

  dino.style.bottom = `${groundY + dinoY}px`;
}

function updateObstacle() {
  obstacleX -= speed;

  if (obstacleX < -30) {
    obstacleX = 680 + Math.random() * 140;
    score += 1;
    speed = Math.min(speed + 0.15, 12);
  }

  obstacle.style.right = `${680 - obstacleX}px`;
}

function hasCollision() {
  const dinoRect = {
    left: dinoX,
    right: dinoX + 34,
    bottom: groundY + dinoY,
    top: groundY + dinoY + 36,
  };

  const obstacleLeft = obstacleX;
  const obstacleRect = {
    left: obstacleLeft,
    right: obstacleLeft + 20,
    bottom: groundY,
    top: groundY + 40,
  };

  return (
    dinoRect.left < obstacleRect.right &&
    dinoRect.right > obstacleRect.left &&
    dinoRect.bottom < obstacleRect.top &&
    dinoRect.top > obstacleRect.bottom
  );
}

function updateUI() {
  scoreEl.textContent = `Score: ${score}`;
}

function stopGame() {
  gameOver = true;
  gameRunning = false;
  gameOverEl.classList.remove('hidden');
}

function loop() {
  if (gameRunning && !gameOver) {
    updateDino();
    updateObstacle();
    updateUI();

    if (hasCollision()) {
      stopGame();
    }
  }

  requestAnimationFrame(loop);
}

document.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    jump();
  }
});

jumpBtn.addEventListener('click', jump);

updateUI();
loop();
