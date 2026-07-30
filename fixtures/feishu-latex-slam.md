SLAM 的核心可以概括为：**根据运动模型和传感器观测，同时估计机器人轨迹与环境地图。**

### 1. 后验概率估计

设机器人状态为 \(x_{0:t}\)，地图为 \(m\)，观测为 \(z_{1:t}\)，控制量为 \(u_{1:t}\)：

\[
p(x_{0:t},m\mid z_{1:t},u_{1:t})
\]

SLAM 通常求最大后验估计：

\[
(x_{0:t}^{*},m^{*})
=
\arg\max_{x_{0:t},m}\p(x_{0:t},m\mid z_{1:t},u_{1:t})
\]

### 2. 运动模型

\[
x_t=f(x_{t-1},u_t)+w_t
\]

其中 \(w_t\sim\mathcal N(0,Q_t)\) 是运动噪声。

### 3. 观测模型

\[
z_t=h(x_t,m)+v_t
\]

其中 \(v_t\sim\mathcal N(0,R_t)\) 是观测噪声。

### 4. 三维位姿变换

机器人或相机位姿通常属于李群 \(SE(3)\)：

\[
T=
\begin{bmatrix}
R & t\\
0 & 1
\end{bmatrix},
\qquad R\in SO(3),\quad t\in\mathbb R^3
\]

世界坐标点 \(P_w\) 变换到相机坐标系：

\[
P_c=RP_w+t
\]

相对位姿为：

\[
T_{ij}=T_i^{-1}T_j
\]

### 5. 相机投影模型

若 \(P_c=(X,Y,Z)^\mathsf T\)，则像素坐标为：

\[
\begin{bmatrix}
u\\v\\1
\end{bmatrix}
=
\frac{1}{Z}
K
\begin{bmatrix}
X\\Y\\Z
\end{bmatrix}
\]

展开后：

\[
u=f_x\frac{X}{Z}+c_x,
\qquad
v=f_y\frac{Y}{Z}+c_y
\]

### 6. 重投影误差

观测像素为 \(z_{ij}\)，地图点为 \(P_j\)，相机位姿为 \(T_i\)：

\[
r_{ij}
=
z_{ij}-\pi(T_iP_j)
\]

其中 \(\pi(\cdot)\) 是相机投影函数。

### 7. Bundle Adjustment

视觉 SLAM 最核心的优化问题之一是：

\[
\min_{\{T_i\},\{P_j\}}
\sum_{(i,j)\in\mathcal O}
\rho\left(
\left\|
z_{ij}-\pi(T_iP_j)
\right\|_{\Sigma_{ij}}^2
\right)
\]

它同时优化相机位姿 \(T_i\) 和地图点 \(P_j\)。\(\rho\) 是鲁棒核函数，用于降低异常匹配的影响。

### 8. 位姿图优化

回环检测后常求解：

\[
\min_{\{T_i\}}
\sum_{(i,j)\in\mathcal E}
\left\|
\operatorname{Log}
\left(
Z_{ij}^{-1}T_i^{-1}T_j
\right)
\right\|_{\Omega_{ij}}^2
\]

其中 \(Z_{ij}\) 是测得的相对位姿，\(\Omega_{ij}\) 是信息矩阵。

归根结底，现代 SLAM 最核心的统一形式就是：

\[
\boxed{
x^{*}
=
\arg\min_x
\sum_k
\rho_k\!\left(
r_k(x)^\mathsf T
\Omega_k
r_k(x)
\right)
}
\]

也就是：构造运动、视觉、IMU 和回环等残差，然后通过非线性最小二乘求出最可能的轨迹与地图。
