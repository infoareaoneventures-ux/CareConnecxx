import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, db } from '../lib/firebase';
import { ClientIntakeData } from '../types';
import { ClientNavigation } from './client/ClientNavigation';

export default function ClientProfileDashboard() {
  const navigate = useNavigate();
  const [intakeData, setIntakeData] = useState<ClientIntakeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(auth?.currentUser);

  useEffect(() => {
    const fetchData = async () => {
      if (!auth?.currentUser) {
        navigate('/login');
        return;
      }

      setUser(auth.currentUser);

      try {
        const docRef = db!.collection('clientIntakes').doc(auth.currentUser.uid);
        const docSnap = await docRef.get();

        if (docSnap.exists) {
          setIntakeData(docSnap.data() as ClientIntakeData);
        }
      } catch (error) {
        console.error('Error fetching intake data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <ClientNavigation />

      <main className="max-w-5xl mx-auto px-4 py-8">
        {/* Welcome Banner */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl shadow-lg p-8 mb-8 text-white">
          <div className="flex items-start space-x-4">
            <div className="bg-white/20 rounded-full p-3">
              <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <h2 className="text-2xl font-bold mb-2">Welcome to Evia!</h2>
              <p className="text-blue-100 text-lg">
                Thank you for filling out your care inquiry. Your profile is now set up.
              </p>
              <p className="text-blue-100 mt-2">
                Our care coordinator will reach out to you soon at {intakeData?.phone}.
              </p>
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Care Request Summary */}
          <div className="md:col-span-2 space-y-6">
            <div className="bg-white rounded-xl shadow-sm p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <svg className="w-5 h-5 mr-2 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                Your Care Request
              </h3>
              
              {intakeData && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-500">Care Recipient</p>
                      <p className="font-medium text-gray-900">{intakeData.recipientName}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-500">Relationship</p>
                      <p className="font-medium text-gray-900">{intakeData.relationship}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-500">Location</p>
                      <p className="font-medium text-gray-900">{intakeData.zipCode}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-500">Schedule</p>
                      <p className="font-medium text-gray-900">{intakeData.schedule}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-500">Start Date</p>
                      <p className="font-medium text-gray-900">
                        {new Date(intakeData.startDate).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-500">Duration</p>
                      <p className="font-medium text-gray-900">{intakeData.duration}</p>
                    </div>
                  </div>

                  <div className="bg-gray-50 rounded-lg p-4">
                    <p className="text-sm text-gray-500 mb-2">Care Needs</p>
                    <div className="flex flex-wrap gap-2">
                      {intakeData.careTypes.map((careType) => (
                        <span
                          key={careType}
                          className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm"
                        >
                          {careType}
                        </span>
                      ))}
                    </div>
                  </div>

                  {intakeData.additionalComments && (
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-500 mb-1">Additional Comments</p>
                      <p className="text-gray-700">{intakeData.additionalComments}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* What's Next */}
            <div className="bg-white rounded-xl shadow-sm p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <svg className="w-5 h-5 mr-2 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                What's Next?
              </h3>
              <div className="space-y-4">
                <div className="flex items-start space-x-3">
                  <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-blue-600 font-semibold text-sm">1</span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">Care Coordinator Review</p>
                    <p className="text-gray-600 text-sm">Our team is reviewing your request and will contact you within 24 hours.</p>
                  </div>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-gray-600 font-semibold text-sm">2</span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">Caregiver Matching</p>
                    <p className="text-gray-600 text-sm">We'll match you with vetted caregivers who meet your specific needs.</p>
                  </div>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-gray-600 font-semibold text-sm">3</span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">Interview & Select</p>
                    <p className="text-gray-600 text-sm">Meet caregivers and choose the best fit for your family.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Status Card */}
            <div className="bg-white rounded-xl shadow-sm p-6">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Request Status
              </h3>
              <div className="flex items-center space-x-2">
                <span className="w-3 h-3 bg-yellow-400 rounded-full animate-pulse"></span>
                <span className="font-medium text-gray-900">Pending Review</span>
              </div>
              <p className="text-sm text-gray-600 mt-2">
                Submitted {intakeData?.createdAt ? 'recently' : 'recently'}
              </p>
            </div>

            {/* Contact Card */}
            <div className="bg-white rounded-xl shadow-sm p-6">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Your Contact Info
              </h3>
              <div className="space-y-2 text-sm">
                <p className="text-gray-900 font-medium">{intakeData?.contactName}</p>
                <p className="text-gray-600">{intakeData?.email}</p>
                <p className="text-gray-600">{intakeData?.phone}</p>
              </div>
              <button className="mt-4 text-blue-600 text-sm hover:underline">
                Edit contact info
              </button>
            </div>

            {/* Need Help? */}
            <div className="bg-blue-50 rounded-xl p-6">
              <h3 className="text-sm font-semibold text-blue-900 uppercase tracking-wide mb-2">
                Need Help?
              </h3>
              <p className="text-sm text-blue-700 mb-4">
                Have questions or need to update your request?
              </p>
              <a
                href="tel:1-800-CARE-CONNEX"
                className="inline-flex items-center text-blue-700 font-medium hover:text-blue-800"
              >
                <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
                </svg>
                Call us
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
