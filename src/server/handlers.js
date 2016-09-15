var bb = require('bluebird');
var request = bb.promisify(require('request'));
var request2 = require('request');
var keys = require('./keys.js');
var qs = require('querystring');
var Yelp = require('yelp');
var session = require('express-session');
var _ = require('lodash');
var User = require('./dbconfig/schema.js').User;
var Address = require('./dbconfig/schema.js').Address;
var bcrypt = require('bcrypt');
var stripe = require("stripe")("sk_test_xg4PkTku227mE5Pub1jJvIj5");


const gmapsURL = 'https://maps.googleapis.com/maps/api/directions/json';

var yelp = new Yelp({
  'consumer_key': keys.yelp,
  'consumer_secret': keys.yelpSecret,
  'token': keys.yelpToken,
  'token_secret': keys.yelpTokenSecret
});


module.exports = {
  login: (req, res, next) => {
    var username = req.body.username;
    var password = req.body.password;

    User.findOne({username: username}).then(user => {
      if (user) {
        // sets the current session to the logged in user
        // req.session.username = username;

        // Checks the hashed password in the database against the password
        // attached to the request body.
        bcrypt.compare(password, user.password, function (error, result) {

          if (error) {
            // Conditional to catch any errors the bcrypt module throws.
            console.log(error);
            res.send({message: 'Error signing in.', valid: false});

          } else if (result) {
            // Conditional where the hashed and unhashed passwords match.
            res.send({message: 'Successfully signed in.', valid: true});

          } else {
            // Conditional where the hashed and unhashed passwords don't match.
            res.send({message: 'Invalid password.', valid: false});
          }
        });
      } else {
        // Conditional for when the username is not found in the database.
        res.send({message: 'Invalid username.', valid: false});
      }
    });
  },

  signup: (req, res, next) => {
    var username = req.body.username;
    var password = bcrypt.hashSync(req.body.password, 5);
    User.find({username: username}).then(users => {
      if (users.length) {
        res.send({message: 'That username already exists.', valid: false});
      } else {
        // adds a new user to the database
        new User({username: username, password: password}).save().then(user => {
          // req.session.username = username;
          res.send({message: 'New user added to database', valid: true});
        })
      }
    });
  },

  saveOptions: (req, res, next) => {
    // updates user preferences in the database
    var username = req.body.username;
    var prefs = req.body.userPrefs;
    User.findOneAndUpdate({username: username},
                          {$set: {preferences: prefs}},
                          {new: true},
                          (err, result) => {
      if (err) {
        res.send({message: 'Error updating preferences.', valid: false});
      } else {
        res.send({message: 'Preferences updated.', valid: true});
      }
    });
  },

  getOptions: (req, res, next) => {
    // sends user preferences to the client
    var username = req.query.user;
    User.findOne({username: username}).then(user => {
      res.send(user.preferences);
    }).catch(err => {
      res.send('Error retrieving preferences.');
    });
  },


  /*
   * Input: (String, String, Function)
   * Output: Promise
   * Description: Given a starting and ending address, gives an object
   *              containing an array of routes in promise form.
   */
  getRoutes: function (origin, destination, mode) {

    // Concatenate query parameters into HTTP request friendly string.
    let queryString = qs.stringify({
      origin: origin,
      destination: destination,
      key: keys.googleMaps,
      mode: mode,
    });

    // Specify parameters for request.
    let options = {
      url: `${gmapsURL}?${queryString}`,
      method: 'GET'
    };

    // Make request to Google Directions API.
    return request(options);
  },

  // Takes form data from submit
  // Outputs routes or addresses for the map

  submit: function(req, res, next) {
    module.exports.getRoutes(req.body.start, req.body.end, req.body.mode)
    .then(results => {
      // Parse nested object returned by Google's API to
      // specifically get Array of routes.
      var routesArray = JSON.parse(results.body).routes;

      User.findOne({
        username: req.body.user,
      }).then(function (response) {

        // Call getRestaurants along the returned route.
        module.exports.getRestaurants(req, res, routesArray, response.preferences);

      }).catch(function (error) {

        // Call getRestaurants along the returned route.
        module.exports.getRestaurants(req, res, routesArray);

      });
    })
    .catch(err => {
      console.log('Error requesting routes: ', err);
      res.end();
    });
  },

  chargeCard: (req,res) => {
    var token = req.body.stripeToken; // Using Express

    var charge = stripe.charges.create({
      amount: 1000, // Amount in cents
      currency: "usd",
      source: token,
      description: "Example charge"
    }, function(err, charge) {
      if (err && err.type === 'StripeCardError') {
        res.status(400)
      } else {
        res.status(201).send("Charge succesful")
      }
    });
  },

  /*
   * Input: Array
   * Output: Promise
   * Description: Takes in the route object returned by Google's API,
   *              and returns an array of restaurant objects from Yelp.
   */
  getRestaurants: (req, res, routesArray, preferences, token) => {
    preferences = preferences || [];

    // Object to be returned to the client.
    // Stores route and restaurants in two seperate arrays.
    var responseObject = {
      route: routesArray,
      restaurants: [],
      paymentRequired: false
    };

    // Stores the segments along a route for querying Yelp.
    var segmentsArray = [];

    // Stores all of the Google defined "steps" along a route.
    var steps = [];

    // Determine the total length of a route in meters.
    var totalRouteDistance = 0;
    routesArray[0].legs.forEach(function (leg) {
      totalRouteDistance += leg.distance.value;
      steps = steps.concat(leg.steps);
    });

    //"Number below represents 500 miles"
    if (totalRouteDistance > 804672){
      console.log("does it reach here?")
        responseObject.paymentRequired = true;
    }



    // Calculates the length of the segments produced by cutting a given route into 10ths.
    var averageSegmentLength = totalRouteDistance / 10;

  // Breaks down all of Google's given 'steps' into 10 uniform segments of equal length.
    var start, end;
    var distanceFromTarget = averageSegmentLength / 2;

    // Iterate over each step along a route.
    for (var i = 0; i < steps.length; i++) {

      // Check if a segment's target midpoint lies along a given step.
      if (steps[i].distance.value >= distanceFromTarget) {

        // Grab the step's start and stop coordinates.
        start = steps[i].start_location;
        end = steps[i].end_location;

        // Calculate the midpoint of the given segment using MATH!
        var midpoint = {
          lat: start.lat + ((end.lat - start.lat) * (distanceFromTarget / steps[i].distance.value)),
          lng: start.lng + ((end.lng - start.lng) * (distanceFromTarget / steps[i].distance.value)),
        };

        // Generate the appropriate segment object and add it to the storage array.
        segmentsArray.push({
          distance: averageSegmentLength,
          midpoint: midpoint,
        });

        // Chop off the beginning of a given step that has already been evaluated.
        steps[i].start_location = midpoint;
        steps[i].distance.value -= distanceFromTarget;
        distanceFromTarget = averageSegmentLength;
        i--;
      } else {

        // If the step doesn't contain the midpoint for a segment,
        // move on to the next step and decrease the remaining distance from target
        // by the step's distance.
        distanceFromTarget -= steps[i].distance.value;
      }
    }


    // Keeps track of the number of Yelp queries we've made.
    var queryCounter = 0;
    var validBusinesses;
    var searchParameters;

    // Makes a unique Yelp query for each step along the given route.
    segmentsArray.forEach(function (step, index) {
      // console.log(step);
      // Establish parameters for each individual yelp query.
      searchParameters = {
        'radius_filter': Math.min(Math.max(step.distance, 100), 39999),
        'll': `${step.midpoint.lat},${step.midpoint.lng}`,
        'accuracy': 100,
        'category_filter': 'restaurants',
        'term': preferences.join('_') + '_restaurants'
      };

      // Query Yelp's API.
      yelp.search(searchParameters)

        // Sucess callback
        .then(function (searchResults) {

          // Filter out businesses returned by yelp that are in weird locations.
          validBusinesses = searchResults.businesses.filter(function (item) {

            if (!item.location.coordinate) {
              // If the business doesn't have a location property, filter it out.
              return false;

            } else {

              // Calculate the how far away the business is.
              var latDifference = step.midpoint.lat - item.location.coordinate.latitude;
              var lngDifference = step.midpoint.lng - item.location.coordinate.longitude;
              var totalDegreeDifference = Math.sqrt(Math.pow(latDifference, 2) + Math.pow(lngDifference, 2));
              var totalDistance = totalDegreeDifference / 0.000008998719243599958;

              // Compare the distrance from the business agains the upper limit,
              // and filter accordingly.
              return totalDistance < Math.max(step.distance / 2, 100);
            }
          });



          // Add the returned businessees to the restauraunts array.
          responseObject.restaurants = responseObject.restaurants.concat(validBusinesses);
          responseObject.restaurants = _.uniqBy(responseObject.restaurants, 'id');

          // Send a response to the client if all requisite queries have been made.
          queryCounter++;
          queryCounter >= segmentsArray.length ? res.send(responseObject) : null;
        })

        // Error callback
        .catch(function (error) {
          console.log('Yelp returned an error:', error);

          // Send a response to the client if all requisite queries have been made.
          queryCounter++;
          queryCounter >= segmentsArray.length ? res.send(responseObject) : null;
        });
    });
  },

  /**
   * Input: String
   * Output: Array
   * Description: Returns a list of addresses for a specific user
   */
  getAddresses: (req, res, next) => {
    let user = req.query.user;

    //get user id
    User.findOne({username: user})

    //search by addresses user id
    .then(user => {
      if (user) {
        Address.find({user: user._id})
          .then(addresses => {
            res.send(addresses);
          });
      } else {
        res.send([]);
      }
    })

    .catch(error => {
      console.log('Error getting addresses: ', error);
      res.send([]);
    });
  },

  /**
   * Input: Object
   * Output: Undefined
   * Description: Saves a new address
   */
  saveAddress: (req, res, next) => {
    let address = req.body;

    //Get user id by username
    User.findOne({username: address.user})
    .then(user => {
      //create new address
      return new Address({
        user: user._id,
        //address lines
        label: address.label,
        location: address.location
      }).save();
    })
    .then(() => {
      res.send();
    })
    .catch(error => {
      console.log('Error saving address: ', error);
    });
  }
};
