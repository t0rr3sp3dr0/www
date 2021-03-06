'use strict';

const Submission = require('../../common/models/submission'),
  Problem = require('../../common/models/problem'),
  Contest = require('../../common/models/contest'),
  Queue = require('../services/queue'),
  Utils = require('../../common/lib/utils');

const async = require('async'),
  fs = require('fs'),
  multiparty = require('multiparty'),
  _ = require('lodash');

function createSubmission(submission, userId, callback) {
  let sub = new Submission({
    contest: submission.contest,
    contestant: userId,
    rep: submission.rep,
    problem: submission.problem,
    language: submission.language,
    code: submission.code
  });
  if (!submission.problem) sub.verdict = 15;
  sub.save(callback);
}

exports.tryExtractFile = (req, res, next) => {
  if (req.body.id) return next();
  let form = new multiparty.Form(), fpath;
  async.waterfall([
    (callback) => {
      form.parse(req, callback);
    },
    (fields, files, callback) => {
      try {
        fpath = files.file[0].path;
        req.body = {};
        req.body.id = fields.id[0];
        req.body.problem = fields.problem[0];
        req.body.language = fields.language[0];
      } catch (err) {
        return callback(err);
      }
      fs.readFile(fpath, 'utf8', callback);
    },
    (code, callback) => {
      req.body.code = code;
      fs.unlink(fpath, callback);
    }
  ], (err) => {
    if (err) return res.status(400).send();
    return next();
  });
};

exports.submit = (req, res) => {
  req.body.contest = req.body.id;
  delete req.body.id;

  let submission = req.body, userId = req.user._id, problem;

  if (Submission.validateChain(req).seeLanguage().seeCode().notOk()) {
    return res.status(400).send();
  }

  if (submission.problem === 0) submission.problem = null;
  async.waterfall([
    (next) => {
      async.parallel({
        contest: (next) => {
          Contest.findById(submission.contest, 'contestants problems', next);
        },
        problem: (next) => {
          if (!submission.problem) return next();
          Problem.findById(submission.problem, next);
        }
      }, next);
    },
    (results, next) => {
      if (!results.contest) return next(new Error());
      if (results.problem && !results.contest.problemInContest(submission.problem) ||
          !results.contest.userInContest(userId)) return next(new Error());
      if (results.contest.date_start > new Date()) return next(new Error());
      if (!_.some(submission.language, results.contest.languages)) return next(new Error());
      submission.rep = results.contest.getUserRepresentative(userId);
      problem = results.problem;
      createSubmission(submission, userId, next);
    },
    (_submission, next) => {
      submission = _submission;
      if (submission.problem === null) return next();
      Queue.pushSubmission(problem.oj, submission, next);
    },
  ], (err) => {
    if (err) return res.status(400).send();
    return res.json({
      submission: submission
    });
  });
};

exports.getById = (req, res) => {
  Submission.findById(req.params.id)
  .populate({ path: 'contest', select: 'name' })
  .populate({ path: 'contestant', select: 'local.username' })
  .populate({ path: 'problem', select: 'name' })
  .exec((err, submission) => {
    if (err) return res.status(500).send();
    if (!submission) return res.status(400).send();
    return res.json({
      submission: submission
    });
  });
};

exports.getRepContestSubmissions = (req, res) => {
  let contestId = req.params.id;
  let startFrom = new Date(_.toInteger(req.params.from) || 0);
  Contest.findById(contestId, (err, contest) => {
    if (err) return res.status(500).send();
    if (!contest) return res.status(400).send();
    let rep = contest.getUserRepresentative(req.user._id);
    if (!rep) return res.status(400).send();
    Submission.find({
      contest: contestId,
      rep: rep,
      date: {$gte: startFrom}
    })
    .select('_id date verdict language problem')
    .sort('date')
    .exec((err, submissions) => {
      if (err) return res.status(500).send();
      let isBlind = !contest.hasEnded() && new Date() >= contest.blind_time;
      if (isBlind) {
        _.map(submissions, (s) => {
          if (s.date >= contest.blind_time) s.verdict = 0;
          return s;
        });
      }
      return res.json({submissions: submissions});
    });
  });
};

exports.getRepProblemSubmissions = (req, res) => {
  let contestId = req.params.id;
  let repId = req.params.rid;
  let problemId = req.params.pid;
  Contest.findById(contestId, (err, contest) => {
    if (err) return res.status(500).send();
    if (!contest) return res.status(400).send();
    let rep = contest.getUserRepresentative(req.user._id);
    if (!req.user.isAdmin && !Utils.cmpToString(req.user._id, contest.author)) {
      return res.status(400).send();
    }
    Submission.find({
      contest: contestId,
      rep: repId,
      problem: problemId
    })
    .select('_id date verdict language problem')
    .sort('-date')
    .exec((err, submissions) => {
      if (err) return res.status(500).send();
      return res.json({submissions: submissions});
    });
  });
};
