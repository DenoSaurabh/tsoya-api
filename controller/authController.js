const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { promisify } = require('util');

const User = require('../models/user.model');

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const chatkit = require('../utils/chatkit');

const signToken = id => {
  console.log(process.env.JWT_SECRET);

  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN
  });
};

const createSendToken = (user, statusCode, req, res) => {
  const token = signToken(user._id);

  res.cookie('jwt', token, {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https'
  });

  // Remove password from output
  user.password = undefined;
  user.referalLinkAdmin = undefined;
  user.disableMiddlewareHooks = undefined;
  user.userAdmin = undefined;

  // Including Chatkit Auth
  const authData = chatkit.authenticate({
    userId: user.name
  });

  res.status(statusCode).json({
    status: 'success',
    token,
    chatToken: authData.body,
    data: {
      user
    }
  });
};

// SAMLL MIDDLEWARE FOR REFERAL LINK USERS
exports.referalLink = (req, res, next) => {
  if (!req.params.link) next();

  req.body.referalLinkAdmin = req.params.link;
};

// User SignUp
exports.signUp = catchAsync(async (req, res, next) => {
  console.log(req.body);

  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    gender: req.body.gender,
    age: req.body.age,
    credits: 120,
    referalLinkAdmin: null
  });
  console.log(newUser);

  await chatkit.createUser({
    id: req.body.name,
    name: req.body.name
  });

  const authData = chatkit.authenticate({
    userId: req.body.id
  });

  // Including Chatkit Token
  newUser.chatAuth = authData.body;

  // await new Email(newUser, url).sendWelcome();

  createSendToken(newUser, 201, req, res);
});

exports.login = catchAsync(async (req, res, next) => {
  const { id, password } = req.query;

  if (!id || !password) {
    return next(new AppError('Please provide id and password!', 400));
  }

  const user = await User.findOne({ name: id }).select('+password');
  console.log(user);

  if (!user || !(await user.correctPassword(password, user.password))) {
    console.log('Incorred!!');
    return next(new AppError('Incorrect id or password', 401));
  }

  // For Banned Admins
  if (user.banned) {
    return next(new AppError('You are banned from the Server!', 403));
  }

  // If the User is one of profiles of Admin
  if (user.userAdmin) {
    return next(new AppError('YOu cannot login with that user !!', 400));
  }

  console.log('logged');

  createSendToken(user, 200, req, res);
});

exports.chatLogin = catchAsync(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }

  // 2) Verification token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // 3) Check if user still exists
  const currentUser = await User.findById(decoded.id);
  if (!currentUser) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        401
      )
    );
  }

  const authData = chatkit.authenticate({
    userId: currentUser.name
  });

  res.status(200).json(authData.body);
});

// Restricted Routes for some users
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    // roles ['owner', 'admin']. role='user'
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }

    next();
  };
};

// Forgot Password
exports.forgotPassword = catchAsync(async (req, res, next) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with email address.', 404));
  }

  // 2) Generate the random reset token
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // 3) Send it to user's email
  try {
    const resetURL = `${req.protocol}://${req.get(
      'host'
    )}/api/v1/users/resetPassword/${resetToken}`;
    // await new Email(user, resetURL).sendPasswordReset();

    res.status(200).json({
      status: 'success',
      message: `Token sent to email! ${resetURL}`
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    return next(
      new AppError('There was an error sending the email. Try again later!'),
      500
    );
  }
});

// Reset Password
exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() }
  });

  // 2) If token has not expired, and there is user, set the new password
  if (!user) {
    return next(new AppError('Token is invalid or has expired', 400));
  }
  user.password = req.body.password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  // 3) Update changedPasswordAt property for the user
  // 4) Log the user in
  createSendToken(user, 200, req, res);
});

// Protecting Endpoints for some users
exports.protect = catchAsync(async (req, res, next) => {
  // 1) Getting token and check of it's there
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }

  // 2) Verification token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // 3) Check if user still exists
  const currentUser = await User.findById(decoded.id);
  if (!currentUser) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        401
      )
    );
  }

  // 4) Check if user changed password after the token was issued
  if (currentUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError('User has changed password! Please log in again!', 401)
    );
  }

  // GRANT ACCESS TO PROTECTED ROUTE
  req.user = currentUser;
  res.locals.user = currentUser;
  next();
});

exports.isLoggedIn = async (req, res, next) => {
  if (req.cookies.jwt) {
    try {
      // 1) verify token
      const decoded = await promisify(jwt.verify)(
        req.cookies.jwt,
        process.env.JWT_SECRET
      );

      // 2) Check if user still exists
      const currentUser = await User.findById(decoded.id);
      if (!currentUser) {
        return next();
      }

      // 3) Check if user changed password after the token was issued
      if (currentUser.changedPasswordAfter(decoded.iat)) {
        return next();
      }

      res.locals.user = currentUser;
      return next();
    } catch (err) {
      return next();
    }
  }
  next();
};
